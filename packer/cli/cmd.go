// Command routepack turns GPX routes into the compact string a
// SuuntoPlus feature carries.
//
// The same conversion runs in a browser, from the page in docs/,
// which is this code compiled to WebAssembly rather than a second
// implementation of it.
//
// This file only parses the command line and wires the chosen
// subcommand to a logger. All behaviour lives in the internal packages.
package main

import (
	"github.com/alecthomas/kong"
	"github.com/renard/cwlog/logger"
)

var log logger.Logger = logger.Null()

// version is injected at build time with
// -ldflags "-X main.version=...". It is "dev" otherwise.
var version = "dev"

// CLI is the root command set. Each subcommand lives in its own
// cmd-<name>.go file.
type CLI struct {
	Verbose bool    `short:"v" help:"Enable debug logging."`
	Pack    PackCmd `cmd:"" help:"Convert GPX files into the watch's string."`
}

func main() {
	var cli CLI
	ctx := kong.Parse(&cli,
		kong.Name("routepack"),
		kong.Description("Pack GPX routes into the string a Suunto "+
			"watch feature carries. Version "+version+"."),
	)

	level := logger.InfoLevel
	if cli.Verbose {
		level = logger.DebugLevel
	}
	log = logger.StdWithLevel(level)

	ctx.FatalIfErrorf(ctx.Run())
}
