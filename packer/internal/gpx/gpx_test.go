package gpx_test

import (
	"strings"
	"testing"

	"github.com/renard/navigator/packer/internal/gpx"
)

const simple = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <metadata><name>Test route</name></metadata>
  <wpt lat="48.84043" lon="2.31513"><name>Alfa</name></wpt>
  <wpt lat="48.84163" lon="2.32005"><name>Bravo</name></wpt>
  <rte>
    <rtept lat="48.84043" lon="2.31513"/>
    <rtept lat="48.84163" lon="2.32005"/>
  </rte>
</gpx>`

func TestParseSimple(t *testing.T) {
	f, err := gpx.Parse(strings.NewReader(simple), gpx.Limits{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if f.Title != "Test route" {
		t.Errorf("title = %q", f.Title)
	}
	if len(f.Waypoints) != 2 {
		t.Fatalf("got %d waypoints, want 2", len(f.Waypoints))
	}
	if f.Waypoints[0].Name != "Alfa" {
		t.Errorf("first waypoint = %q", f.Waypoints[0].Name)
	}
	if len(f.Line) != 2 || f.FromTrack {
		t.Errorf("line = %d points, fromTrack = %v", len(f.Line), f.FromTrack)
	}
}

func TestTrackIsUsedWhenThereIsNoRoute(t *testing.T) {
	doc := `<gpx><wpt lat="1" lon="1"><name>A</name></wpt>
	  <trk><trkseg>
	    <trkpt lat="1.0" lon="1.0"/><trkpt lat="1.1" lon="1.1"/>
	  </trkseg></trk></gpx>`
	f, err := gpx.Parse(strings.NewReader(doc), gpx.Limits{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !f.FromTrack || len(f.Line) != 2 {
		t.Errorf("fromTrack = %v, line = %d", f.FromTrack, len(f.Line))
	}
}

func TestBeginIsDroppedAndEndIsKept(t *testing.T) {
	doc := `<gpx>
	  <wpt lat="1" lon="1"><name>Start</name><type>Begin</type></wpt>
	  <wpt lat="2" lon="2"><name>Middle</name></wpt>
	  <wpt lat="3" lon="3"><name>Finish</name><type>End</type>
	    <desc>Auto-generated</desc></wpt>
	  <wpt lat="4" lon="4"><name>Twin</name><desc>Auto-generated</desc></wpt>
	  <rte><rtept lat="1" lon="1"/><rtept lat="3" lon="3"/></rte>
	</gpx>`
	f, err := gpx.Parse(strings.NewReader(doc), gpx.Limits{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	var names []string
	for _, w := range f.Waypoints {
		names = append(names, w.Name)
	}
	want := "Middle Finish"
	if got := strings.Join(names, " "); got != want {
		t.Errorf("kept %q, want %q", got, want)
	}
}

// The security tests. Each is a document that should be refused rather
// than parsed, and each has been a real way to attack an XML reader.

func TestDoctypeIsRefused(t *testing.T) {
	doc := `<?xml version="1.0"?>
	<!DOCTYPE gpx [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
	<gpx><wpt lat="1" lon="1"><name>&xxe;</name></wpt></gpx>`
	_, err := gpx.Parse(strings.NewReader(doc), gpx.Limits{})
	if err == nil {
		t.Fatal("a DOCTYPE was accepted")
	}
	if !strings.Contains(err.Error(), "DOCTYPE") {
		t.Errorf("refused for the wrong reason: %v", err)
	}
}

func TestEntityExpansionIsRefused(t *testing.T) {
	// The billion laughs, which needs a DOCTYPE to declare itself and
	// is stopped twice over: the declaration is refused, and Go would
	// not expand a custom entity anyway.
	doc := `<!DOCTYPE lolz [
	  <!ENTITY lol "lol">
	  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
	]><gpx><wpt lat="1" lon="1"><name>&lol2;</name></wpt></gpx>`
	if _, err := gpx.Parse(strings.NewReader(doc), gpx.Limits{}); err == nil {
		t.Fatal("entity expansion was accepted")
	}
}

func TestUnknownEntityIsRefused(t *testing.T) {
	doc := `<gpx><wpt lat="1" lon="1"><name>&secret;</name></wpt></gpx>`
	if _, err := gpx.Parse(strings.NewReader(doc), gpx.Limits{}); err == nil {
		t.Fatal("an undeclared entity was accepted")
	}
}

func TestDeepNestingIsRefused(t *testing.T) {
	var b strings.Builder
	b.WriteString("<gpx>")
	for i := 0; i < 500; i++ {
		b.WriteString("<a>")
	}
	for i := 0; i < 500; i++ {
		b.WriteString("</a>")
	}
	b.WriteString("</gpx>")
	_, err := gpx.Parse(strings.NewReader(b.String()), gpx.Limits{})
	if err == nil {
		t.Fatal("a deeply nested document was accepted")
	}
	if !strings.Contains(err.Error(), "deep") {
		t.Errorf("refused for the wrong reason: %v", err)
	}
}

func TestTooManyPointsIsRefused(t *testing.T) {
	var b strings.Builder
	b.WriteString("<gpx><trk><trkseg>")
	for i := 0; i < 200; i++ {
		b.WriteString(`<trkpt lat="1" lon="1"/>`)
	}
	b.WriteString("</trkseg></trk></gpx>")
	_, err := gpx.Parse(strings.NewReader(b.String()),
		gpx.Limits{MaxPoints: 100})
	if err == nil {
		t.Fatal("a document over the point limit was accepted")
	}
}

func TestCoordinatesOffTheEarthAreRefused(t *testing.T) {
	doc := `<gpx><wpt lat="91" lon="0"><name>Nowhere</name></wpt></gpx>`
	if _, err := gpx.Parse(strings.NewReader(doc), gpx.Limits{}); err == nil {
		t.Fatal("a latitude of 91 was accepted")
	}
}

func TestBadCoordinatesAreRefused(t *testing.T) {
	doc := `<gpx><wpt lat="NaN-ish" lon="0"><name>X</name></wpt></gpx>`
	if _, err := gpx.Parse(strings.NewReader(doc), gpx.Limits{}); err == nil {
		t.Fatal("a non numeric latitude was accepted")
	}
}

func TestLatin1IsDecoded(t *testing.T) {
	// The name is Pres-Hauts with an accented e, written as one byte.
	doc := "<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?>\n" +
		"<gpx><wpt lat=\"1\" lon=\"1\"><name>Pr\xe9s-Hauts</name></wpt>" +
		"<rte><rtept lat=\"1\" lon=\"1\"/><rtept lat=\"2\" lon=\"2\"/>" +
		"</rte></gpx>"
	f, err := gpx.Parse(strings.NewReader(doc), gpx.Limits{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if f.Waypoints[0].Name != "Prés-Hauts" {
		t.Errorf("name = %q", f.Waypoints[0].Name)
	}
}

func TestUnknownCharsetIsRefused(t *testing.T) {
	doc := `<?xml version="1.0" encoding="EBCDIC"?><gpx></gpx>`
	if _, err := gpx.Parse(strings.NewReader(doc), gpx.Limits{}); err == nil {
		t.Fatal("an unsupported character set was accepted")
	}
}
