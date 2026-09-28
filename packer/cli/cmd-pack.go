package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/renard/navigator/packer/internal/gpx"
	"github.com/renard/navigator/packer/internal/route"
)

// PackCmd converts files named on the command line, for the times a
// browser is not wanted.
type PackCmd struct {
	Files []string `arg:"" help:"GPX files to pack." type:"existingfile"`
	Data  string   `help:"Write the result into this data file instead of printing it." type:"path"`
	Slot  int      `help:"Slot size in bytes." default:"2048"`
}

// Run packs the files and either prints the string or writes the data
// file the app is built with.
func (c *PackCmd) Run() error {
	var routes []route.Route
	for _, name := range c.Files {
		f, err := os.Open(name)
		if err != nil {
			return fmt.Errorf("pack: %w", err)
		}
		parsed, err := gpx.Parse(f, gpx.Limits{})
		f.Close()
		if err != nil {
			return fmt.Errorf("pack: %s: %w", filepath.Base(name), err)
		}
		title := strings.TrimSuffix(filepath.Base(name), ".gpx")
		one, err := parsed.Route(title)
		if err != nil {
			return fmt.Errorf("pack: %s: %w", filepath.Base(name), err)
		}
		fmt.Printf("%-24s %2d waypoints  %5.0f m  %4d bytes\n",
			filepath.Base(name), len(one.Waypoints), one.LengthM,
			len(one.Pack()))
		routes = append(routes, one)
	}

	for _, note := range route.Check(routes) {
		fmt.Fprintln(os.Stderr, "note:", note)
	}

	packed := route.Pack(routes)
	fmt.Printf("\n%d routes, %d bytes of %d\n", len(routes), len(packed),
		c.Slot)
	if len(packed) > c.Slot {
		return fmt.Errorf("pack: too long for the slot")
	}

	if c.Data == "" {
		fmt.Printf("\n%s\n", packed)
		return nil
	}

	// The slot is sized by the value the data file ships, so it is
	// padded to the full length rather than left short.
	padded := packed + strings.Repeat(" ", c.Slot-len(packed))
	body := fmt.Sprintf("{\"route\": %q}\n", padded)
	if err := os.WriteFile(c.Data, []byte(body), 0o644); err != nil {
		return fmt.Errorf("pack: %w", err)
	}
	fmt.Printf("written to %s, padded to %d\n", c.Data, c.Slot)
	return nil
}
