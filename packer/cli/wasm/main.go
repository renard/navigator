//go:build js && wasm

// The converter, compiled for a browser.
//
// WHY this rather than the same rules written again in JavaScript:
// the packing rules are exactly the kind of thing that drifts when
// there are two copies. What a name may carry, how far apart two
// waypoints have to be to count as one place, which waypoint of a
// Suunto export is the auto generated twin, how the length is
// measured. One of those changing in Go and not in JavaScript would
// produce a string that builds and then misleads a pilot.
//
// So the page runs this, which is the same source the command line
// tool runs, through the same tests. It costs 2.7 MB, 0.8 MB over the
// wire, once, for a tool nobody opens twice a day.
//
// Built by: make site
package main

import (
	"encoding/json"
	"strings"
	"syscall/js"

	"github.com/renard/navigator/packer/internal/gpx"
	"github.com/renard/navigator/packer/internal/route"
)

// answer is what the page draws. It is the same shape the HTTP server
// used to return, so the page's own code did not have to change when
// the server went away.
type answer struct {
	Packed  string   `json:"packed"`
	Bytes   int      `json:"bytes"`
	Slot    int      `json:"slot"`
	Routes  []shown  `json:"routes"`
	Notes   []string `json:"notes"`
	Refused []string `json:"refused"`
}

type shown struct {
	Name      string   `json:"name"`
	LengthM   int      `json:"lengthM"`
	Waypoints []string `json:"waypoints"`
	Bytes     int      `json:"bytes"`
	FromTrack bool     `json:"fromTrack"`
}

// pack takes [{name, text}, ...] and gives back the answer as JSON.
//
// A file that cannot be read is refused by name and the others are
// still converted, because one bad export in a folder of ten should
// not cost the other nine.
func pack(this js.Value, args []js.Value) any {
	var routes []route.Route
	var refused []string

	files := args[0]
	for i := 0; i < files.Length(); i++ {
		entry := files.Index(i)
		name := entry.Get("name").String()
		text := entry.Get("text").String()

		parsed, err := gpx.Parse(strings.NewReader(text), gpx.Limits{})
		if err != nil {
			refused = append(refused, name+": "+err.Error())
			continue
		}
		one, err := parsed.Route(strings.TrimSuffix(name, ".gpx"))
		if err != nil {
			refused = append(refused, name+": "+err.Error())
			continue
		}
		if len(routes) >= route.MaxRoutes {
			refused = append(refused, name+": too many routes at once")
			continue
		}
		routes = append(routes, one)
	}

	packed := route.Pack(routes)
	out := answer{
		Packed:  packed,
		Bytes:   len(packed),
		Slot:    route.SlotBytes,
		Notes:   route.Check(routes),
		Refused: refused,
		Routes:  []shown{},
	}
	// A nil slice in Go is null in JSON, and null is not something a
	// page should have to guard against on every field.
	if out.Notes == nil {
		out.Notes = []string{}
	}
	if out.Refused == nil {
		out.Refused = []string{}
	}
	for _, one := range routes {
		names := make([]string, 0, len(one.Waypoints))
		for _, wp := range one.Waypoints {
			names = append(names, route.CleanName(wp.Name))
		}
		out.Routes = append(out.Routes, shown{
			Name:      route.CleanName(one.Name),
			LengthM:   int(one.LengthM + 0.5),
			Waypoints: names,
			Bytes:     len(one.Pack()),
		})
	}

	body, err := json.Marshal(out)
	if err != nil {
		return `{"refused":["the answer could not be encoded"]}`
	}
	return string(body)
}

func main() {
	js.Global().Set("navigatorPack", js.FuncOf(pack))
	// The Go runtime exits when main returns, taking the exported
	// function with it, so it waits here for the page to call.
	select {}
}
