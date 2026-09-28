# routepack

Turn GPX routes into the compact string a SuuntoPlus feature carries,
from the command line or from a page in a browser.

The page is in `../docs`, and it is this same code compiled to
WebAssembly, not a second implementation of it. The packing rules are
exactly the kind of thing that drifts when there are two copies: what
a name may carry, how far apart two waypoints have to be to count as
one place, which point of a Suunto export is the auto generated twin.
One of those changing here and not there would produce a string that
builds and then misleads a pilot.

## Motivation

A SuuntoPlus feature can read the watch's distance to the next
waypoint, but not where the waypoints of the route are, and the
watch's navigation pauses its waypoint values once the wearer is more
than about a hundred meters from the line. A feature that carries its
own copy of the route knows every waypoint from the first second,
wherever the aircraft is, which is when a pilot pushed off track by
wind needs it.

That copy travels as one string, short enough to be compiled into the
app or pasted into a setting from the phone. Building it by hand is out
of the question, and the people who fly these routes are not the people
who enjoy running a Python script. So: drop the GPX files a flight
planner already produced onto a page, get the string back.

The string looks like this, one route per entry, entries joined by a
bar:

```
<route>:<lat>,<lon>,<name>;<lat>,<lon>,<name>;...
```

Coordinates are degrees scaled by 1e5, about a meter, which is finer
than the GPS under them and two digits cheaper than 1e7. Names are cut
to fourteen characters, which is what the watch's name row holds.

The route's length was carried here too, as a fingerprint the watch
could have matched against its own distance to destination. Nothing
ever read it and the pilot picks the route with a button, so it was
dropped and every route got six characters back. It is still measured
and shown, it just does not travel.

## What it does with a file

- The start point is dropped, since nothing navigates to where it
  already is, and the end point is kept, since that is the destination.
- A Suunto export writes an auto generated twin beside every named
  waypoint. Those are dropped, except an auto generated End.
- Two waypoints within five meters are one place under two names, which
  happens when a file carries both a user named finish and a typed end
  point. The second is dropped.
- The route's geometry comes from its `rtept` elements when it has
  them and from its `trkpt` elements otherwise, and the length is
  measured along it.
- Waypoints keep the order the file gives them. GPX defines no order
  for standalone waypoints, but every export seen here lists them in
  travel order, and reordering them by where they project onto the line
  would be worse: on a route that doubles back, a waypoint can project
  onto the wrong pass. The projection is computed anyway and
  disagreement is reported rather than silently corrected.
- Accented letters are folded to ASCII and anything that is not a
  letter, a digit or ordinary punctuation is dropped, which is both
  what the watch's font can draw and what keeps a name from breaking
  the format.

## What it does with your files

Nothing, which is the point, and now for a simpler reason than before.

There was an HTTP server here, with a cap on the body, a cap on the
number of parts, a read deadline, a token bucket per address, and a
multipart reader chosen so that an upload could never spill into a
temporary file. All of that existed to make it safe to send somebody
else a route. It is gone: the page runs the converter in the visitor's
own tab, so the file never leaves their machine and there is no server
to harden. Deleting a server beats securing one.

What is left is the care the format itself needs:

- **The XML is treated as hostile.** A document type declaration is
  refused outright, which closes both XML external entities and entity
  expansion. Nesting is capped, the number of points is capped,
  coordinates must be on Earth, and only UTF-8, ASCII and the two
  Latin-1 flavours are decoded.
- **Names are treated as hostile**, both as output and as text. The
  four separators the format is built on never survive a name, or a
  waypoint could split a field in two. Beyond that, only letters,
  digits and `-_.'()/+` are kept: the string ends up in a JSON file, in
  an XML template and in a web page, and a place name is not where the
  escaping rules of any of those should be tested.
- The page renders every value through `textContent`, never through
  `innerHTML`.

## Build

Requires Go 1.23 or later. Nothing else.

```
$ make
$ ./routepack --help
```

`make site` builds the browser version into `../docs`, which needs no
extra toolchain: Go carries its own WebAssembly support and the loader
script the page uses.

## Use

In a browser, from `../docs/convert.html`, opened locally or served
anywhere static. Drop GPX files on it: it shows each route with its
length and waypoints, the packed string, how much of the slot it uses,
and anything worth warning about. The string can be copied, or
downloaded as the `data.json` the watch app is built with.

From the command line:

```
$ ./routepack pack ../examples/Cannes-Nice.gpx
Cannes-Nice.gpx           5 waypoints  32164 m   125 bytes

1 routes, 125 bytes of 2048

Cannes-Nice:4354931,701499,Cannes;4353200,703739,Cap Croisette;4354237,713642,Antibes;4368995,729006,Nice;4369738,728531,Port
```

With `--data` the result is written straight into the app's data file,
padded to the slot size so the watch sizes the slot correctly:

```
$ ./routepack pack --data ../watch/data.json ../examples/*.gpx
[...]
written to ../watch/data.json, padded to 2048
```

## Warnings it gives

- A route with fewer than two waypoints, which is not a route.
- Two routes of the same name, since the name is what tells them
  apart on the watch.
- A waypoint sitting earlier on the line than the one before it in the
  file.
- A string longer than the slot holds, with how much has to go.

## Layout

- `cli/` is the command line and nothing else, one file per command.
- `internal/gpx` reads a GPX document, and explains its precautions.
- `internal/route` holds the compact format and the rules for building
  it.
- `cli/wasm` is the same conversion, exposed to a browser.
- `../docs` is the page, and what GitHub Pages serves.
