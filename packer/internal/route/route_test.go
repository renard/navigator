package route_test

import (
	"math"
	"strings"
	"testing"

	"github.com/renard/navigator/packer/internal/route"
)

func TestCleanNameFoldsAccents(t *testing.T) {
	if got := route.CleanName("Prés-Hauts"); got != "Pres-Hauts" {
		t.Errorf("got %q", got)
	}
	// Folded, then cut to what the name row holds.
	if got := route.CleanName("Sainte-Colline du Haut"); got != "Sainte-Colline" {
		t.Errorf("got %q", got)
	}
}

// The one way a route file can corrupt what the watch reads is a name
// carrying a separator, which would split a field in two.
func TestCleanNameRemovesSeparators(t *testing.T) {
	for _, bad := range []string{
		"a|b", "a:b", "a;b", "a,b", "a|b:c;d,e",
	} {
		got := route.CleanName(bad)
		if strings.ContainsAny(got, route.Separators) {
			t.Errorf("CleanName(%q) = %q, still has a separator", bad, got)
		}
	}
}

func TestCleanNameRemovesControlCharacters(t *testing.T) {
	got := route.CleanName("Alfa\x00\x1b[31m\nBravo")
	if !route.Printable(got) {
		t.Errorf("got %q, which is not printable", got)
	}
	if got != "Alfa 31m Bravo" {
		t.Errorf("got %q", got)
	}
}

func TestCleanNameTruncates(t *testing.T) {
	got := route.CleanName("a very long waypoint name indeed")
	if len([]rune(got)) > route.MaxNameChars {
		t.Errorf("got %q, %d characters", got, len([]rune(got)))
	}
}

// A name is allowed letters, digits and a little punctuation, and
// nothing else. The packed string ends up in JSON, in XML and in a web
// page, and a name is not where the escaping of any of those should be
// tested.
func TestCleanNameKeepsOnlyWhatAPlaceNameNeeds(t *testing.T) {
	for _, bad := range []string{
		"<script>x</script>", `say "hi"`, "a&b", "back\\slash",
		"drop%20it", "${home}", "tick`s",
	} {
		got := route.CleanName(bad)
		if strings.ContainsAny(got, "<>\"&%${}`") {
			t.Errorf("CleanName(%q) = %q", bad, got)
		}
	}
	if got := route.CleanName("Dunmore (EGXX)"); got != "Dunmore (EGXX)" {
		t.Errorf("ordinary punctuation was lost: %q", got)
	}
}

func TestCleanNameDropsWhatItCannotFold(t *testing.T) {
	got := route.CleanName("Alfa ✈️ 中")
	if !route.Printable(got) {
		t.Errorf("got %q, which is not printable", got)
	}
}

func TestPackShape(t *testing.T) {
	r := route.Route{
		Name:    "Coastal run",
		LengthM: 1902.4,
		Waypoints: []route.Waypoint{
			{Lat: 48.84043, Lon: 2.31513, Name: "Alfa"},
			{Lat: 48.83928, Lon: 2.31607, Name: "End"},
		},
	}
	want := "Coastal run:4884043,231513,Alfa;4883928,231607,End"
	if got := r.Pack(); got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
}

func TestPackJoinsRoutes(t *testing.T) {
	one := route.Route{Name: "A", LengthM: 1, Waypoints: []route.Waypoint{
		{Lat: 1, Lon: 1, Name: "x"}}}
	two := route.Route{Name: "B", LengthM: 2, Waypoints: []route.Waypoint{
		{Lat: 2, Lon: 2, Name: "y"}}}
	got := route.Pack([]route.Route{one, two})
	if strings.Count(got, "|") != 1 {
		t.Errorf("got %q", got)
	}
}

func TestDedupDropsTheSamePlaceTwice(t *testing.T) {
	// Two points three meters apart, which is inside SamePlaceM.
	points := []route.Waypoint{
		{Lat: 48.84043, Lon: 2.31513, Name: "Finish"},
		{Lat: 48.840457, Lon: 2.31513, Name: "End"},
		{Lat: 48.83928, Lon: 2.31607, Name: "Elsewhere"},
	}
	got := route.Dedup(points)
	if len(got) != 2 {
		t.Fatalf("got %d points, want 2", len(got))
	}
	if got[0].Name != "Finish" || got[1].Name != "Elsewhere" {
		t.Errorf("kept %q and %q", got[0].Name, got[1].Name)
	}
}

func TestDistanceIsRight(t *testing.T) {
	// One minute of latitude is a nautical mile, to within a meter.
	got := route.Distance(48.0, 2.0, 48.0+1.0/60.0, 2.0)
	if math.Abs(got-1852) > 4 {
		t.Errorf("got %.1f m, want about 1852", got)
	}
}

// With the length gone from the format, the name is all the watch has
// to tell one route from another.
func TestCheckWarnsOnASharedName(t *testing.T) {
	// Two names that differ in the file and stop differing once cut
	// to what the watch's name row holds, which is the way this
	// actually happens.
	same := []route.Route{
		{Name: "Valley hop, north side", Waypoints: []route.Waypoint{{}, {}}},
		{Name: "Valley hop, north face", Waypoints: []route.Waypoint{{}, {}}},
	}
	notes := route.Check(same)
	found := false
	for _, n := range notes {
		if strings.Contains(n, "tells them apart") {
			found = true
		}
	}
	if !found {
		t.Errorf("no warning about the shared name: %v", notes)
	}
}

func TestCheckWarnsWhenTheSlotIsTooSmall(t *testing.T) {
	var many []route.Route
	for i := 0; i < 30; i++ {
		wps := make([]route.Waypoint, 20)
		for j := range wps {
			wps[j] = route.Waypoint{Lat: 48, Lon: 2, Name: "waypointname12"}
		}
		many = append(many, route.Route{
			Name: "a route name", LengthM: float64(1000 + i), Waypoints: wps})
	}
	notes := route.Check(many)
	found := false
	for _, n := range notes {
		if strings.Contains(n, "over the") {
			found = true
		}
	}
	if !found {
		t.Errorf("no warning about the slot: %v", notes)
	}
}
