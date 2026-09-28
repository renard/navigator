// Package route holds the compact form a route takes on the watch and
// the rules for building it.
//
// WHY: a SuuntoPlus feature is given no way to read the route the watch
// is navigating, and past about a hundred meters off the line the watch
// stops talking about it at all. A route the feature carries itself has
// neither limit: every waypoint is known from the first second, on
// route or not. It travels as one string, either compiled into the app
// or pushed as a setting from the phone, so it has to be short and it
// has to survive being pasted through a text field.
package route

import (
	"fmt"
	"math"
	"strings"
	"unicode"
)

// The string the watch reads, one route per entry, entries joined by a
// bar:
//
//	<route>:<lat>,<lon>,<name>;<lat>,<lon>,<name>;...
//
// The route's length used to be carried here as a fingerprint, on the
// idea that the watch's own distance to destination would identify
// which route was being flown. Nothing ever read it, the pilot picks
// the route with a button, and every route paid six characters for
// it. The length is still measured and shown here, it just does not
// travel.
const (
	// Degrees scaled by 1e5 is about 1.1 m, finer than the GPS under
	// it and two digits cheaper than 1e7.
	CoordScale = 1e5

	// Long enough to read a real waypoint name rather than a stub. The
	// name row holds fourteen characters without wrapping.
	MaxNameChars = 14

	// Two waypoints this close are one place under two names, which
	// happens when a file carries both a user named finish and a typed
	// end point. Navigating to the second at zero distance helps
	// nobody.
	SamePlaceM = 5.0

	// The declared length of the route slot, which is what sizes it on
	// the watch.
	SlotBytes = 2048

	// Nothing sane comes near these, and a file that does is either
	// broken or hostile. They bound the work done per request.
	MaxRoutes    = 32
	MaxWaypoints = 200
)

// Separators are the four characters that give the format its shape. A
// name carrying one of them would split a field in two, so they never
// reach the output.
const Separators = "|:;,"

// Punctuation is what a place name is allowed to carry besides letters,
// digits and spaces.
//
// This is a list of what is allowed rather than of what is forbidden,
// which is the only way round that stays right. The packed string ends
// up in a JSON file, in an XML template, in a web page and in a text
// field on a phone, and a name is not the place to find out which of
// those escapes what. Angle brackets, quotes, ampersands and backslashes
// mean something to at least one of them and nothing to a waypoint.
const Punctuation = "-_.'()/+ "

// Waypoint is one named place on a route.
type Waypoint struct {
	Lat  float64
	Lon  float64
	Name string
}

// Route is a named chain of waypoints with the length of the line that
// joins them, which is what identifies it on the watch.
type Route struct {
	Name      string
	LengthM   float64
	Waypoints []Waypoint

	// OutOfOrder names the waypoints that project onto the route
	// earlier than the one before them in the file. They are left
	// where the file put them, since on a route that doubles back a
	// waypoint can project onto the wrong pass, but the disagreement
	// is worth saying out loud.
	OutOfOrder []string
}

// Distance returns the great circle distance between two points, in
// meters.
func Distance(lat1, lon1, lat2, lon2 float64) float64 {
	const earthM = 6371000.0
	la1, lo1 := lat1*math.Pi/180, lon1*math.Pi/180
	la2, lo2 := lat2*math.Pi/180, lon2*math.Pi/180
	h := math.Pow(math.Sin((la2-la1)/2), 2) +
		math.Cos(la1)*math.Cos(la2)*math.Pow(math.Sin((lo2-lo1)/2), 2)
	return 2 * earthM * math.Asin(math.Sqrt(math.Min(1, h)))
}

// PolylineLength returns the length of a chain of points, in meters.
func PolylineLength(points []Waypoint) float64 {
	total := 0.0
	for i := 0; i+1 < len(points); i++ {
		total += Distance(points[i].Lat, points[i].Lon,
			points[i+1].Lat, points[i+1].Lon)
	}
	return total
}

// AlongTrack returns how far along a polyline a point sits, in meters.
//
// Each segment is measured flat, which is ample over a leg, and the
// nearest projection wins. This only serves to notice that a file
// disagrees with its own route.
func AlongTrack(lat, lon float64, line []Waypoint) float64 {
	const mPerDegLat = 111320.0
	bestAt, bestOff := 0.0, math.Inf(1)
	walked := 0.0
	for i := 0; i+1 < len(line); i++ {
		a, b := line[i], line[i+1]
		mPerDegLon := mPerDegLat * math.Cos(a.Lat*math.Pi/180)
		px := (lon - a.Lon) * mPerDegLon
		py := (lat - a.Lat) * mPerDegLat
		bx := (b.Lon - a.Lon) * mPerDegLon
		by := (b.Lat - a.Lat) * mPerDegLat
		span := bx*bx + by*by
		t := 0.0
		if span > 0 {
			t = math.Max(0, math.Min(1, (px*bx+py*by)/span))
		}
		off := math.Hypot(px-t*bx, py-t*by)
		if off < bestOff {
			bestOff = off
			bestAt = walked + t*math.Sqrt(span)
		}
		walked += math.Sqrt(span)
	}
	return bestAt
}

// CleanName makes a name safe to put in the compact string and legible
// on the watch.
//
// WHY: the format is four separators deep and a name carrying one of
// them would split a field in two, which is the one way a route file
// can corrupt what the watch reads. Names also come from every mapping
// tool there is, so they arrive with accents, tabs, emoji and the
// occasional control character. Everything outside printable ASCII is
// either folded to its nearest letter or dropped, which is also what
// the watch's own font can draw.
func CleanName(name string) string {
	var b strings.Builder
	space := false
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			r = ' '
		}
		if strings.ContainsRune(Separators, r) {
			r = ' '
		}
		if r > 0x7f {
			folded, ok := fold[r]
			if !ok {
				continue
			}
			r = folded
		}
		letter := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9')
		if !letter && !strings.ContainsRune(Punctuation, r) {
			continue
		}
		if r == ' ' {
			// Runs of space collapse, and a leading one is dropped.
			if space || b.Len() == 0 {
				continue
			}
			space = true
			b.WriteRune(r)
			continue
		}
		space = false
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	if len([]rune(out)) > MaxNameChars {
		out = string([]rune(out)[:MaxNameChars])
		out = strings.TrimSpace(out)
	}
	return out
}

// fold maps the accented letters a European route file actually carries
// onto the ASCII the watch can draw. Anything not here is dropped
// rather than guessed at.
var fold = map[rune]rune{
	'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a',
	'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
	'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i',
	'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o', 'ø': 'o',
	'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u',
	'ý': 'y', 'ÿ': 'y', 'ñ': 'n', 'ç': 'c', 'ß': 's',
	'À': 'A', 'Á': 'A', 'Â': 'A', 'Ã': 'A', 'Ä': 'A', 'Å': 'A',
	'È': 'E', 'É': 'E', 'Ê': 'E', 'Ë': 'E',
	'Ì': 'I', 'Í': 'I', 'Î': 'I', 'Ï': 'I',
	'Ò': 'O', 'Ó': 'O', 'Ô': 'O', 'Õ': 'O', 'Ö': 'O', 'Ø': 'O',
	'Ù': 'U', 'Ú': 'U', 'Û': 'U', 'Ü': 'U',
	'Ý': 'Y', 'Ñ': 'N', 'Ç': 'C',
	// A typographic apostrophe is an apostrophe, not a space. A
	// planner writing Etangs d’Yveline should not come back as
	// Etangs d Yveline and lose one of the fourteen characters a
	// name is allowed.
	'’': '\'', '‘': '\'', '“': ' ', '”': ' ',
	'–': '-', '—': '-', ' ': ' ',
}

// Dedup drops a waypoint standing on the one before it.
func Dedup(points []Waypoint) []Waypoint {
	out := make([]Waypoint, 0, len(points))
	for _, p := range points {
		if n := len(out); n > 0 {
			last := out[n-1]
			if Distance(last.Lat, last.Lon, p.Lat, p.Lon) < SamePlaceM {
				continue
			}
		}
		out = append(out, p)
	}
	return out
}

// Pack turns one route into its entry of the compact string.
func (r Route) Pack() string {
	var b strings.Builder
	b.WriteString(CleanName(r.Name))
	b.WriteByte(':')
	for i, w := range r.Waypoints {
		if i > 0 {
			b.WriteByte(';')
		}
		fmt.Fprintf(&b, "%d,%d,%s",
			int64(math.Round(w.Lat*CoordScale)),
			int64(math.Round(w.Lon*CoordScale)),
			CleanName(w.Name))
	}
	return b.String()
}

// Pack joins several routes into the one string the watch is given.
func Pack(routes []Route) string {
	parts := make([]string, 0, len(routes))
	for _, r := range routes {
		parts = append(parts, r.Pack())
	}
	return strings.Join(parts, "|")
}

// Check reports what is wrong with a set of routes without refusing to
// produce anything, because a warning the pilot can read beats a
// failure they cannot.
func Check(routes []Route) []string {
	var notes []string
	if len(routes) == 0 {
		return []string{"no route to pack"}
	}

	seen := map[string]int{}
	for _, r := range routes {
		seen[CleanName(r.Name)]++
		if len(r.Waypoints) < 2 {
			notes = append(notes, fmt.Sprintf(
				"%s carries %d waypoint, which is not a route",
				CleanName(r.Name), len(r.Waypoints)))
		}
		if len(r.OutOfOrder) > 0 {
			notes = append(notes, fmt.Sprintf(
				"in %s, %s sit earlier on the line than the waypoint "+
					"before them in the file, and were left in file order",
				CleanName(r.Name), strings.Join(r.OutOfOrder, ", ")))
		}
	}
	for name, count := range seen {
		if count > 1 {
			notes = append(notes, fmt.Sprintf(
				"%d routes are called %s, and the name is the only "+
					"thing that tells them apart on the watch",
				count, name))
		}
	}

	size := len(Pack(routes))
	if size > SlotBytes {
		notes = append(notes, fmt.Sprintf(
			"%d characters is %d over the %d the slot holds: drop a "+
				"route, or shorten some names",
			size, size-SlotBytes, SlotBytes))
	}
	return notes
}

// Printable reports whether a string is plain ASCII with no control
// characters, which is what may be handed back to a browser or written
// into the app's data file.
func Printable(s string) bool {
	for _, r := range s {
		if r > unicode.MaxASCII || r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}
