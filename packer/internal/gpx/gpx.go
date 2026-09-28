// Package gpx reads a GPX file into the waypoints and the line that a
// route is packed from.
//
// WHY the parsing is written by hand rather than unmarshalled into a
// struct: a GPX file arrives from the internet, and XML is a format
// with a long history of turning a parser into a weapon. Streaming the
// tokens is what makes the limits below enforceable while the document
// is being read, instead of after a hostile one has already been held
// in memory.
//
// What is refused, and why:
//
//   - a DOCTYPE, in any form. Go's decoder resolves no external entity
//     and expands no custom one, so neither XXE nor a billion laughs
//     works against it today. Refusing the declaration outright means
//     that stays true if that ever changes, and no real GPX file
//     carries one.
//   - a document deeper than maxDepth. Nesting is the one thing a
//     streaming parser still pays for, since it keeps a stack.
//   - more points than the caller allows. A file inside the size limit
//     can still hold a hundred thousand track points.
//   - anything but UTF-8, ASCII and the two Latin-1 flavours. The
//     character sets are decoded here, in twenty lines, rather than by
//     pulling in a text library.
package gpx

import (
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/renard/navigator/packer/internal/route"
)

// Limits bound the work one document may cause. Zero means the
// default.
type Limits struct {
	MaxPoints int
	MaxDepth  int
}

const (
	defaultMaxPoints = 100000
	defaultMaxDepth  = 40

	// A name longer than this is not a name. It is truncated to the
	// watch's own limit later anyway.
	maxRawNameBytes = 256
)

// File is what one GPX document gives up: a title, the named waypoints
// and the line they are strung on.
type File struct {
	Title     string
	Waypoints []route.Waypoint

	// Line is the route's geometry, from its rtept elements when it has
	// them and from its trkpt elements otherwise. It is what the length
	// is measured along.
	Line []route.Waypoint

	// FromTrack records which of the two the line came from, since a
	// recorded track and a planned route are not the same thing and the
	// difference is worth showing.
	FromTrack bool
}

// Parse reads a GPX document.
//
// The two shapes that turn up are handled. A Suunto export carries a
// route and writes an auto generated twin beside every named waypoint.
// Other tools export a recorded track with the waypoints typed rather
// than described. When a file has both, the route wins, because it is
// the line that was planned.
//
// The start point is dropped, since nothing navigates to where it
// already is, and the end point is kept, since that is the destination.
func Parse(r io.Reader, limits Limits) (*File, error) {
	if limits.MaxPoints <= 0 {
		limits.MaxPoints = defaultMaxPoints
	}
	if limits.MaxDepth <= 0 {
		limits.MaxDepth = defaultMaxDepth
	}

	dec := xml.NewDecoder(r)
	dec.Strict = true
	dec.CharsetReader = charsetReader

	out := &File{}
	var rtept, trkpt []route.Waypoint

	// The element currently being filled, and the text gathered inside
	// it. Only the handful of leaves that matter are collected.
	var (
		depth     int
		path      []string
		text      strings.Builder
		wptOpen   bool
		wpt       route.Waypoint
		wptType   string
		wptDesc   string
		wptNamed  bool
		metaTitle string
		points    int
	)

	inside := func(tag string) bool {
		for _, p := range path {
			if p == tag {
				return true
			}
		}
		return false
	}

	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("gpx: %w", err)
		}

		switch t := tok.(type) {
		case xml.Directive:
			// A DOCTYPE is the only directive a GPX file could carry
			// and there is no honest reason for one.
			if head := strings.Fields(string(t)); len(head) > 0 &&
				strings.EqualFold(head[0], "DOCTYPE") {
				return nil, errors.New(
					"gpx: the file declares a DOCTYPE, which no route " +
						"file needs and this tool will not read")
			}

		case xml.StartElement:
			depth++
			if depth > limits.MaxDepth {
				return nil, fmt.Errorf(
					"gpx: nested more than %d deep", limits.MaxDepth)
			}
			name := strings.ToLower(t.Name.Local)
			path = append(path, name)
			text.Reset()

			switch name {
			case "wpt":
				wptOpen = true
				wptNamed = false
				wptType, wptDesc = "", ""
				wpt = route.Waypoint{}
				lat, lon, err := coords(t)
				if err != nil {
					return nil, err
				}
				wpt.Lat, wpt.Lon = lat, lon
			case "rtept", "trkpt":
				points++
				if points > limits.MaxPoints {
					return nil, fmt.Errorf(
						"gpx: more than %d points", limits.MaxPoints)
				}
				lat, lon, err := coords(t)
				if err != nil {
					return nil, err
				}
				p := route.Waypoint{Lat: lat, Lon: lon}
				if name == "rtept" {
					rtept = append(rtept, p)
				} else {
					trkpt = append(trkpt, p)
				}
			}

		case xml.CharData:
			if text.Len() < maxRawNameBytes {
				text.Write(t)
			}

		case xml.EndElement:
			name := strings.ToLower(t.Name.Local)
			value := strings.TrimSpace(text.String())
			text.Reset()

			switch name {
			case "name":
				switch {
				case wptOpen:
					wpt.Name = value
					wptNamed = value != ""
				case inside("metadata") && metaTitle == "":
					metaTitle = value
				}
			case "type":
				if wptOpen {
					wptType = value
				}
			case "desc", "cmt", "src":
				if wptOpen {
					wptDesc += " " + value
				}
			case "wpt":
				wptOpen = false
				if keep(wptNamed, wptType, wptDesc) {
					out.Waypoints = append(out.Waypoints, wpt)
				}
			}

			if n := len(path); n > 0 {
				path = path[:n-1]
			}
			depth--
		}
	}

	out.Title = metaTitle
	out.Line = rtept
	if len(out.Line) < 2 {
		out.Line = trkpt
		out.FromTrack = true
	}
	return out, nil
}

// keep decides whether a wpt element is a waypoint the pilot named.
//
// A Begin is where the flight starts, and nothing navigates to it. An
// auto generated point is the twin Suunto writes beside every named
// one, and only the End among those is a destination worth keeping.
func keep(named bool, kind, desc string) bool {
	if !named {
		return false
	}
	if strings.EqualFold(kind, "Begin") {
		return false
	}
	if strings.Contains(strings.ToLower(desc), "auto-generated") &&
		!strings.EqualFold(kind, "End") {
		return false
	}
	return true
}

// coords pulls lat and lon off an element and rejects anything off the
// planet, which is also what catches a file feeding nonsense into the
// arithmetic downstream.
func coords(e xml.StartElement) (float64, float64, error) {
	var lat, lon float64
	var haveLat, haveLon bool
	for _, a := range e.Attr {
		switch strings.ToLower(a.Name.Local) {
		case "lat":
			v, err := strconv.ParseFloat(a.Value, 64)
			if err != nil {
				return 0, 0, fmt.Errorf("gpx: bad latitude %q", a.Value)
			}
			lat, haveLat = v, true
		case "lon":
			v, err := strconv.ParseFloat(a.Value, 64)
			if err != nil {
				return 0, 0, fmt.Errorf("gpx: bad longitude %q", a.Value)
			}
			lon, haveLon = v, true
		}
	}
	if !haveLat || !haveLon {
		return 0, 0, errors.New("gpx: a point has no coordinates")
	}
	if lat < -90 || lat > 90 || lon < -180 || lon > 180 {
		return 0, 0, fmt.Errorf("gpx: %.5f %.5f is not on Earth", lat, lon)
	}
	return lat, lon, nil
}

// charsetReader decodes the character sets a route file actually comes
// in. Anything else is refused rather than guessed at, since a wrong
// guess turns names into mojibake.
func charsetReader(charset string, input io.Reader) (io.Reader, error) {
	switch strings.ToLower(strings.TrimSpace(charset)) {
	case "", "utf-8", "utf8", "us-ascii", "ascii":
		return input, nil
	case "iso-8859-1", "iso8859-1", "latin1", "latin-1", "windows-1252",
		"cp1252":
		return &latin1Reader{src: input}, nil
	}
	return nil, fmt.Errorf("gpx: character set %q is not supported, "+
		"save the file as UTF-8", charset)
}

// latin1Reader turns one byte per character into UTF-8. Every byte of
// Latin-1 is a code point of the same value, so the conversion needs no
// table.
type latin1Reader struct {
	src     io.Reader
	pending []byte
}

func (l *latin1Reader) Read(p []byte) (int, error) {
	if len(l.pending) > 0 {
		n := copy(p, l.pending)
		l.pending = l.pending[n:]
		return n, nil
	}
	// One byte in can be two bytes out, so never read more than half.
	room := len(p) / 2
	if room == 0 {
		room = 1
	}
	buf := make([]byte, room)
	n, err := l.src.Read(buf)
	if n == 0 {
		return 0, err
	}
	out := make([]byte, 0, n*2)
	for _, b := range buf[:n] {
		out = append(out, []byte(string(rune(b)))...)
	}
	copied := copy(p, out)
	l.pending = out[copied:]
	return copied, err
}
