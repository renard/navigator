package gpx

import (
	"errors"
	"fmt"

	"github.com/renard/navigator/packer/internal/route"
)

// Route turns a parsed file into the route the watch will carry.
//
// The waypoints keep the order they have in the file. GPX defines no
// order for standalone waypoints, only for the points inside a route,
// but every export seen here lists them in travel order. Reordering
// them by where they project onto the line would be worse: on a route
// that doubles back or crosses itself, a waypoint can project onto the
// wrong pass. The projection is computed anyway, and disagreement is
// reported rather than silently corrected.
func (f *File) Route(fallbackTitle string) (route.Route, error) {
	if len(f.Line) < 2 {
		return route.Route{}, errors.New(
			"this file has neither a route nor a track to measure")
	}
	points := route.Dedup(f.Waypoints)
	if len(points) == 0 {
		return route.Route{}, errors.New(
			"this file has no named waypoint to carry")
	}
	if len(points) > route.MaxWaypoints {
		return route.Route{}, fmt.Errorf(
			"this file has %d waypoints, more than the %d a route may "+
				"hold", len(points), route.MaxWaypoints)
	}

	title := f.Title
	if title == "" {
		title = fallbackTitle
	}

	out := route.Route{
		Name:      title,
		LengthM:   route.PolylineLength(f.Line),
		Waypoints: points,
	}

	marks := make([]float64, len(points))
	for i, p := range points {
		marks[i] = route.AlongTrack(p.Lat, p.Lon, f.Line)
	}
	for i := 1; i < len(marks); i++ {
		if marks[i] < marks[i-1] {
			out.OutOfOrder = append(out.OutOfOrder,
				route.CleanName(points[i].Name))
		}
	}
	return out, nil
}
