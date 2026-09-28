# Navigator, the watch half

## Description

A SuuntoPlus feature for Suunto watches with GPS, developed and
tested on a Suunto Ocean, that turns the watch's own route navigation
into a navigator's screen: a ring on the bezel whose marker shows
where the next waypoint is relative to the current ground track, with
distance, bearing, ground speed and time to run.

<p align="center">
  <img src="../docs/images/02-on-track-navigation.jpg" width="320"
       alt="On course for Houdant, 1.1 NM ahead, green marker at the top">
</p>

The pilot builds the route in the Suunto app and starts navigating it
from the sport mode's own Navigation menu, as usual. The app also
carries its own copy of the route, packed into a string by the
converter in `../packer`, which is what lets it keep guiding away
from the line.

## Motivation

The watch's navigation is made for following the line, and does it
precisely: on the route it names the next waypoint and gives the
distance to it to about a meter. Past about 100 m from the line it
considers the wearer off route and pauses the waypoint values until
the route is rejoined. A pilot is often further than that from the
line, and still needs the bearing and the time to the next turn
point. A feature can read the watch's distance to the next waypoint,
but not the waypoint's coordinates.

The distance is enough. Each measurement
says the waypoint lies somewhere on a circle of known radius around a
known position, and circles taken from a moving aircraft meet at one
point. The app solves for that point, and from then on computes its
own bearing and distance, which keeps working away from the line.

That covers the leg being flown, and no further: off route there is no
new waypoint to learn. So the app also carries the whole route, packed
into one string by the converter in `../packer`, either compiled in
through `data.json` or pushed into the route setting from the phone.
With the route in hand every waypoint is known from the first second,
and the screen keeps its distances, its times and its bearing wherever
the aircraft is.

## How it works

- The distance to a fixed point cannot change by more than the
  distance travelled. Anything beyond that means the waypoint itself
  changed, so a leg boundary is detected without ever reading a name.
- Within a leg the measurements accumulate into five running sums.
  Subtracting one reference sample from the rest cancels the
  quadratic terms, which leaves a system linear in the waypoint's two
  coordinates, solved with one 2x2 inverse. Nothing is buffered.
- The same matrix gives the spread of the answer, and what gates the
  bearing is the part of that spread lying across the line of sight.
  Flying straight at a waypoint leaves the fix vague about how far
  away it is and sharp about which way it lies, and only the second
  bends a bearing. Gating on the whole spread refused three legs in
  seven of the reference walk where this refuses one, at no cost in
  accuracy.
- A fix can only be contradicted once it claims to be precise. The
  allowance grows with its own uncertainty, otherwise a fix that
  places the waypoint within 500 m is refuted by a 40 m disagreement,
  reset, rebuilt just as vaguely, and refuted again. That loop cost a
  whole field test.
- A fix that keeps being contradicted by new measurements is dropped
  and the leg starts over. Two waypoints close together, seen from
  far away, can swap without the travel rule noticing.
- Off route the native distance stops. The solved waypoint is ours,
  so distance, bearing and deviation carry on from our own position.

The bearing to the waypoint is plain geometry between our position
and its coordinates, and is worth the noise of one fix divided by the
distance: ten meters at five miles is a twentieth of a degree. What
the deviation ring actually rests on is the ground track, which is
not measured but inferred from where we have been, and that is where
the accuracy goes:

- The window slides instead of being reset when it is used. A window
  that resets leaves the track frozen between resets and stepping
  when they come. On the reference walks the old rule left the track
  unchanged on four ticks in five and then moved it by more than
  twenty degrees thirty-nine times. The sliding one answers on
  ninety-seven ticks in a hundred and passes twenty degrees twice.
- The window reaches back until a hundred meters have been covered,
  not until a fixed time has passed. The angle between two fixes is
  uncertain by the noise of one of them divided by the distance
  between them, so it is the ground covered that sets the precision.
  Thirty seconds is the cap, so a turn is not averaged away.
- Inside the window a line is fitted through every fix by least
  squares rather than subtracting the two ends, which keeps the
  middle of the window instead of throwing it away.

Which waypoint of a stored route is the one being flown to is decided
from where we are, not from what has happened:

- The route is a chain of legs, and the leg we are nearest to is the
  leg we are flying, so its far end is the waypoint. A leg keeps the
  lead until another beats it by fifty meters, which stops a position
  sitting between two of them flipping every second.
- Asked this way the question has the same answer whatever came
  before. A rule that watched for a waypoint being passed cannot do
  that: any passage it misses stays missed. One walk spent nine
  minutes pointing at a waypoint left behind, on a leg cut from the
  far side while off track.
- The watch's own distance still overrules the geometry, but only
  when it fits one waypoint of the route to within thirty meters and
  fits the runner-up thirty meters worse. A distance matching nothing
  is about something else, and a distance matching two waypoints
  equally names neither: one measurement is a circle around us, and
  where a route doubles back that circle cuts it twice.

The screen shows, once the route is known, only what is flown by:

- the name of the waypoint being tracked
- the distance to it in nautical miles
- W, the time to run to the waypoint and the time of arrival there
- D, the same two for the end of the route
- S, the ground speed in knots, and the time of day
- the current position, one line per coordinate, as degrees, minutes
  and seconds to a hundredth

Colour says what a figure is about, in Suunto's own classes: cyan for
the next waypoint, its name, its distance and the W row, dark orange
for the destination, the D row, in the route banner's family but well
clear of the clock's yellow, and white for where you are and how
fast. The time of day is yellow and bold, at 25 rather than 22: bold
is a separate font on the watch, and 25 is the first size drawn in the
bold digit face. Green and red belong to the deviation marker alone.

The position is read straight from the location service rather than
passed through an output of ours, which would round it to about half
a meter and make the last digit noise. Should that resource not hand
a template the whole object, the watch's own formatted rows are shown
instead.

Both arrival times come from the stored route rather than from the
watch, so the END row keeps counting when the watch has stopped
talking about the navigation.

Around all of it, the ring carries a marker at the angle between the
current ground track and the waypoint, so keeping it at the top of
the dial flies the leg. It is filled while the bearing is trusted and
hollow while the leg is still being learned. It never draws a
confident arrow it cannot justify.

The route's name appears large across the dial whenever the down
button is held, with its place in the order it is offered in on a
second line, `2/3`. Stepping through the routes then says both which
one is up and whether there are more to come. It is one element
carrying a newline, with the engine told to keep it. Two elements
stacked was tried and they ran into each other: a line of 28 takes a
quarter of the dial, not the twelve percent its size suggests.

Stepping offers every carried route, nearest first, however far away
it is. A diversion is chosen precisely when none of its waypoints is
near, so a filter by distance would hide the one route the pilot
needs.

The last choice of every round is `--`, no route at all. The app then
carries nothing and works from the watch's own navigation, the native
distance and the waypoint it solves from it, exactly as for a route
that was never packed. It is one hold back from the start of a round.

The banner is the round of choosing. A hold that begins with the
banner down opens a round, and the banner shows the route being
followed, `1/6`, from the moment the hold begins, 0.6 s in. That hold
changes nothing, it is a look. While the banner is up a click goes to
the next route and a hold to the one before, the way the up button
steps the waypoints. The banner stays five seconds after the last
press, and every press made while it is up belongs to the same round.

The order is taken when the round opens and frozen until it ends:
sorted again at every press, it would reshuffle in flight and skip a
route or offer one twice. Starting from the route being followed
means the first step offers the nearest other one, and wrapping comes
back to where it began.

On the apron at LFPZ, with five routes carried, three of them leaving
from there:

    first fix       LFPZ senonche 1/6
    hold            LFPZ senonche 1/6
    click           LFPZ-LFXU 2/6
    click           Chateaux loire 3/6
    hold            LFPZ-LFXU 2/6
    hold            LFPZ senonche 1/6
    hold            -- 6/6

Each timer that lowers the banner first checks that no press came
after the one that set it. Without that, the first of two presses in
quick succession lowered the banner of the second.

main.js writes the text, because it is the side that has the route
list, and the template raises and lowers it, because setStyle does not
answer from main.js. The press does both at once: the handler that
sends the event also shows the banner and sets one timer to take it
away, which is why it works standing still on the apron, where a route
actually gets chosen.

At startup the banner is already up, and main.js fills it on its first
pass with the first route of the list, which is the only one that can
be named before there is a position to judge by. As soon as a fix
arrives it is replaced by the route with a waypoint closest to the
aircraft, the first of the list winning a tie. It stands down after
fifteen seconds, which a warm fix beats and a cold one does not, and
the button brings it back.

Writing the name into the waypoint row instead was tried, to be rid of
the second half. It works and it is wrong: the row that says where you
are going is not the place to put something else, even for two
seconds.

## Buttons

- down, clicked: a lap, or the next route while the route banner is
  up
- down, held: with the banner down, show the route being followed and
  open a round, nearest first and `--` for no route last. With the
  banner up, the route before
- up, clicked: the next waypoint, for a leg that is being cut
- up, held: the waypoint before, to fly it again

So choosing a route is one hold to open the round, then clicks
forward and holds back while the banner is up, as the up button does
for waypoints.

Declaring a handler takes the press away from the watch, so the up
button no longer pauses and the down button no longer opens the
control panel. The down button's click is taken as well, and the lap
is given back by making it the way the watch's own lap view does,
with a put to `Activity/Trigger`. A click while the banner is up is a
step and not a lap, for the five seconds it stays.

The down button also declares `getIsEnabled="true"`. Without it a
declared click is dropped when the display was off at the press, where
the watch's own lap is not, and a lap taken with the wrist down would
be lost. The reference offers `enabledWhileDisplayOff` as an alias,
but the builder turns that bare attribute into an empty element, and
Suunto's own templates all write the long form.

A waypoint chosen by hand holds even while the watch keeps naming
another one, and it goes on holding until the watch comes round to
the same waypoint, at which point its own matching is trusted again.
Otherwise a cut leg would be undone on the very next tick.

## The route

The feature reads its route from one setting, declared in the manifest
and reaching the code through `localStorage`. `data.json` ships that
setting's initial value, and it ships one of the full 2048 characters
even when it is blank: the slot is sized by what it holds, not by the
declared maximum, and two earlier builds that shipped nothing or an
empty string read back nothing at all.

What it ships with are the routes in `../examples`, so a fresh clone
flies something without anybody having to plan a trip first. Replace
them with your own, which is the whole point of the converter:

```
$ cd ../packer && make
$ ./routepack pack --data ../watch/data.json ~/routes/*.gpx
Cannes-Nice.gpx           5 waypoints  32164 m   125 bytes

1 routes, 125 bytes of 2048
written to ../watch/data.json, padded to 2048
```

A word on names, from the example routes. A flight planner may prefix
every waypoint with its type, `POI Sully sur Loire`, `LFPZ SAINT CYR
L'ECOLE`, and four of the fourteen characters the watch's name row
holds then go to the prefix. `LFPZ LFPZ/W1` and `LFPZ LFPZ/W2` come
out differing only in the twelfth character, which is not what a
pilot wants to read in a turn. The packer leaves names as it finds
them. Shortening them where it matters is worth doing in the planner,
before the file is exported.

With it blank the app still runs and falls back on what the watch
says, which is everything while on route and nothing past a hundred
meters off it. That is the behaviour the route is there to fix.

## Build and deploy (Debug / Dev only)

The SuuntoPlus Editor extension for VS Code does the two jobs through
its menus, `SuuntoPlus: Build` and `SuuntoPlus: Deploy to Watch`. The
watch has to be paired with the machine, and the phone must not be
holding the Bluetooth link. On macOS the permission to use Bluetooth
belongs to the application that asks, so VS Code will be asked for
its own.

Then add "Navigator" as a data screen to a GPS sport mode.

**Installing is not copying.** Writing the package straight into
`b:/zapp` puts the bytes in the right place and installs nothing: the
watch does not count it, it does not appear in the SuuntoPlus menus,
and the storage slot that `data.json` provisions is never filled, so
the app has no route even once it is visible. The install is a
separate step, handing the package over and then telling the watch to
install it, which is what the extension's deploy does. Installed that
way nothing has to be restarted: the app and its routes are there
when it returns.

The extension does not talk to the watch either. It starts
`SDSApplicationServer`, a native program shipped inside it, which owns
the Bluetooth link, and drives it over a websocket on the loopback.
A package goes to `b:/zapp/<appID>.fea`, with no display suffix.

A route is a pair of files under `b:/routes`, on the watch's own
filesystem where no feature can reach them. The `.wpt` holds only
names and offsets. The `.sbm` holds everything: a `SBEM0102` header
and then tag, length, value records, where tag 4 is the latitude as a
float, 5 the longitude, 6 the name, 7 the position along the route
from 0 to 1, and 8 a kind, 255 for the two ends and 26 for a waypoint.
One decodes to this:

```
name              lat        lon    along  kind
              46.42075    6.26922   0.000   255
Waypoint 1    46.41851    6.26803   0.109    26
Waypoint 3    46.41307    6.27634   0.471    26
Waypoint 4    46.41556    6.27934   0.619    26
              46.42077    6.26996   1.000   255
```

Which is the whole of what the feature is denied at run time. Nothing
here reads it yet.

What the watch uses to tell one feature from another is the
application id, `naviga01`, not the display name. Old builds under
other ids pile up until the watch refuses with "Maximum amount of
suuntoplus apps enabled", and the phone app does not list them
because they were side loaded. A full sync clears them, since that is
what removes a side loaded feature.

Deploy with the phone's Bluetooth off. Syncing the watch with the
Suunto app removes a feature that was side loaded.

## Known limitations

- The gate has been measured against one walk. It shows a bearing on
  five legs of seven there, the worst of them 4.8 degrees out, and
  refuses the two where the leg was abandoned partway. Refusing is
  the right failure. Walking legs of 40 to 400 m with GPS noise at a
  few meters are a far harder case than flying legs of several miles,
  so the numbers should improve in the air, but that is an
  expectation and not a measurement.
- A leg flown dead straight at the waypoint is the worst case for the
  solver, since the circles become concentric and the fix can slide
  along the track. It is also the case where the bearing matters
  least, because the track already points at the waypoint.
- Everything is learned while on route. Past about a hundred meters
  off the line the watch says nothing, so the app can only replay
  what it already knows. On a leg it has never approached it has
  nothing to show, and neither has the watch. What it does do is
  carry a leg it has already learned through the gap, which is the
  case it exists for.
- A waypoint change cannot be observed while off route. The route
  index keeps advancing out there though, so a waypoint left behind
  is detected and dropped rather than shown as if it were still
  ahead.
- There is no way to read the name of the route being navigated, so a
  route is recognised by its length and its first waypoint rather
  than by name.
- Storing a learned route between flights does not work on a feature
  deployed over USB: a sync erases the feature and its storage, and a
  sync is how routes reach the watch in the first place.
- The waypoint name is read for display only. It is a localisation
  token rather than text when the point was auto generated by the
  Suunto app rather than named by the pilot.
