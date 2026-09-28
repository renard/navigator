// Navigator, the watch half.
//
// The pilot pushes a route with the Suunto app and starts navigating
// it from the sport mode's own Navigation menu. Navigator also holds
// its own copy of the route, packed into one string by the converter
// in ../packer and carried in the route setting.
//
// Both are needed. No resource gives a route waypoint's coordinates,
// and every native waypoint value stops once more than about 100 m
// off the route, which is exactly when a pilot needs it. Two answers
// to that:
//
//   - while the watch is talking, the distance to the next waypoint
//     is exposed and is good to about a meter. Each reading says the
//     waypoint lies on a circle of known radius around a known
//     position, and circles taken from a moving aircraft meet at one
//     point. Solving that gives the waypoint, which is then ours and
//     goes on working when the watch goes quiet.
//   - solving only ever covers the leg being flown, since off route
//     there is no new waypoint to learn. The carried route covers the
//     rest: every waypoint known from the first second, on route or
//     off it.

// A nautical mile in meters, exactly, by definition. Distances are
// carried in meters and shown in miles, so this is the one conversion
// the screen makes.
var NM_M = 1852;

// Meters in a degree of latitude, which is the same everywhere to
// within a fifth of a percent: the meridian is 40 007 km round, so a
// degree is 111.13 km at the poles and 110.57 at the equator, and
// 111.32 is the figure at mid latitudes.
//
// It is used to lay a flat frame over a few kilometers of ground,
// where the curve of the Earth is worth less than the noise of a fix,
// and never over a whole route. A degree of longitude shrinks with
// the cosine of the latitude and is computed where it is needed.
var M_PER_DEG_LAT = 111320.0;

// Nothing above a light aircraft's ceiling is a real ground speed,
// and a reading that high means the fixes it came from are not where
// the aircraft was.
//
// Still worth having after the track moved to a fitted window: on one
// of the reference walks the fit produced 117 knots, on foot, from a
// fix that jumped. That one passed, since the ceiling has to stay
// above what the aircraft can actually do, but it says the guard has
// work to do rather than being there for form's sake. A rejected
// reading leaves the last good speed and track in place, which is
// better than a minute of nonsense in the time to run.
var MAX_PLAUSIBLE_SPEED_MPS = 200 * NM_M / 3600;

// Below this we are standing still and the direction of travel means
// nothing, so the last one that did mean something is kept.
var MOVING_MPS = 0.5;

// How far back the ground track is measured.
//
// The track is the direction of travel, and the only place it can
// come from is where we were against where we are. The angle between
// two fixes is uncertain by roughly the noise of one fix divided by
// the distance between them, so it is the ground covered, not the
// time elapsed, that sets the precision. Ten meters of fix noise
// over a hundred meters of travel is six degrees, whether that
// hundred meters took two seconds in the air or a minute on foot.
//
// So the window reaches back until a hundred meters have been
// covered, and stops at thirty seconds so that a turn is not
// averaged away. In the air the first limit binds and the track is
// two seconds old. On foot the second binds and the track is coarse,
// which is the honest answer: at walking pace there is no hundred
// meter baseline to be had inside half a minute.
var TRACK_BASELINE_M = 100;
var TRACK_WINDOW_S = 30;

// A measurement repeated from the same place adds no geometry: two
// identical circles do not intersect any better than one. Standing
// still would otherwise pour hundreds of near identical rows into the
// sums and skew them towards a single direction, so a sample only
// counts once the position has moved this far from the last one kept.
// Two meters, chosen by replaying the reference walk: it changes
// nothing there, where a step at 1 Hz covers about 1.4 m, while three
// meters throws away two samples in three and slows every lock.
var MIN_STEP_M = 2;

// The distance to a fixed point cannot change by more than the
// distance travelled in the same interval. Anything beyond that plus
// a noise allowance means the point itself moved, which is how a
// waypoint change is detected without reading its name.
var SWITCH_MARGIN_M = 25;

// ClosestPoint keeps advancing while off route, when every other
// route value has gone quiet. Measured over 15 minutes off the line,
// where it ran from 17 to 26 with nothing else answering.
//
// That is what tells a held waypoint it has been left behind. Without
// it a fix survives forever: on one walk the screen pointed at
// Delta for half an hour while the walker stood beside Charlie,
// because nothing ever contradicted a waypoint the watch had stopped
// talking about. Two indices of progress is enough to say the route
// has moved on.
var STALE_INDEX_STEP = 2;

// Coming back on route after a silence, the rule above has no
// baseline to work from. Compare the native distance against our own
// instead, and treat a wide disagreement as a waypoint change.
var STALE_WP_S = 5;
var RESYNC_TOLERANCE_M = 50;

// Distance noise floor, in meters. The residuals calibrate the
// spread by themselves, but a short straight run fits its own few
// samples perfectly and would claim a precision it cannot have, so
// the estimate is never allowed below what this noise implies.
var DIST_SIGMA_M = 1.5;

// Two waypoints close together, seen from far away, can swap without
// the travel rule noticing: the distance barely jumps. That shows up
// later as measurements the current fix cannot explain, so a fix that
// keeps being contradicted is dropped and the leg starts over.
//
// The allowance has to grow with the fix's own uncertainty. A fix
// that places the waypoint within 500 m cannot be refuted by a
// disagreement of 40 m, and resetting on that never let it improve:
// the first field test of v5 spent the whole walk rebuilding a fix it
// threw away a minute later, so a bearing appeared on a quarter of
// the samples and never survived going off route.
var INNOVATION_M = 40;
var INNOVATION_SIGMAS = 3;
var INNOVATION_STRIKES = 4;

// A bearing is worth showing while its own uncertainty stays under
// this, in radians. 0.09 rad is close to five degrees.
//
// What is tested is the uncertainty across the line of sight, not the
// spread of the fix as a whole. Flying straight at a waypoint leaves
// the fix vague about how far away it is and sharp about which way it
// lies, and only the second bends a bearing. Gating on the whole
// spread refused three legs in seven of the reference walk where
// gating across the line of sight refuses one, with no loss: the
// worst bearing shown is under five degrees either way.
var MAX_BEARING_ERROR_RAD = 0.09;

var toRad = function(deg) {
  return deg * Math.PI / 180;
};

// Great circle distance between two WGS84 points, in meters.
var haversineDistance = function(lat1, lon1, lat2, lon2) {
  var r = 6371000;
  var dLat = toRad(lat2 - lat1);
  var dLon = toRad(lon2 - lon1);
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
};

// Initial true bearing from point 1 to point 2, in radians, 0..2*PI.
var bearingTo = function(lat1, lon1, lat2, lon2) {
  var phi1 = toRad(lat1);
  var phi2 = toRad(lat2);
  var dLon = toRad(lon2 - lon1);
  var y = Math.sin(dLon) * Math.cos(phi2);
  var x = Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI);
};

// Wrap a radian angle to -PI..PI, for a signed left or right
// deviation rather than a 0..2*PI compass heading.
var normalizeSignedAngle = function(rad) {
  var a = rad % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

// Where the route comes from.
//
// The setting declared in the manifest arrives through localStorage
// under this key, which is how a third party feature like zzpara01
// takes a race plan typed into the phone. data.json ships the key's
// initial value, and it has to ship one of the full length: the slot
// is sized by what it holds, not by the declared maxLength. Two
// earlier builds, one with no data.json and one with an empty string
// in it, both read back nothing.
//
// So there is one source of routes and not two. An earlier build also
// carried a copy compiled into this file, which was dead the day the
// setting started answering, and had quietly gone stale: it still
// held a Coastal run of 2003 m against the 1902 m the file measures
// now. A second copy of the truth is worse than none.
var STORAGE_KEY = 'route';

// Parsed routes, and which one is being followed.
var routes = null;
var routeChosen = -1;

// The choice of no route at all, offered last in every round. The app
// then carries nothing and works from the watch's own navigation
// alone, as it does for a route that was never packed.
var NO_ROUTE = -1;
var NO_ROUTE_NAME = '--';

// Raised once a route has been proposed or chosen, no route included,
// so the proposal by proximity is made once and never overrides the
// pilot.
var routeSettled = 0;

// Parse the packed string into routes: a name and the waypoints in
// travel order.
//
//   <name>:<lat>,<lon>,<name>;<lat>,<lon>,<name>;...
//
// joined by a bar, with coordinates as degrees scaled by 1e5.
var parseRoutes = function(blob) {
  var out = [];
  if (!blob) {
    return out;
  }
  // The slot is padded with spaces to its full size, so that it is
  // sized right, and without this the padding ends up in the name of
  // the last waypoint of the last route.
  //
  // Trimmed by hand, not with a regular expression. The reference
  // lists the built-in objects the engine has and RegExp is not among
  // them, and no Suunto example uses one.
  var end = blob.length;
  while (end > 0 && blob.charAt(end - 1) === ' ') {
    end--;
  }
  var entries = blob.substring(0, end).split('|');
  for (var i = 0; i < entries.length; i++) {
    var parts = entries[i].split(':');
    if (parts.length < 2) {
      continue;
    }
    var wps = [];
    var items = parts[1].split(';');
    for (var j = 0; j < items.length; j++) {
      var f = items[j].split(',');
      if (f.length < 2) {
        continue;
      }
      wps.push({ lat: parseInt(f[0], 10) / 1e5,
                 lon: parseInt(f[1], 10) / 1e5,
                 name: f.length > 2 ? f[2] : '?' });
    }
    if (wps.length) {
      out.push({ name: parts[0], wps: wps });
    }
  }
  return out;
};

// Read the routes once, from the setting that data.json provisions
// and the phone can overwrite.
var loadRoutes = function() {
  if (routes !== null) {
    return;
  }
  var stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    // Storage out of reach leaves no route, which the screen shows by
    // naming no waypoint. Better than guiding to a stale one.
    stored = null;
  }
  routes = parseRoutes(stored);
};

// Which leg we are on decides the waypoint, and a leg keeps the lead
// until another beats it by this much. A position sitting between
// two legs would otherwise flip between them from one second to the
// next.
var LEG_MARGIN_M = 50;

// How far the stored route may disagree with the watch before the
// waypoint it is talking about is looked up again.
//
// The native distance is good to a meter and our waypoints to a few,
// so a real match is well inside this. What it buys is stickiness:
// waypoints a hundred meters apart are all within a few meters of
// the same distance from a position off to one side, and picking the
// best match every second made the name flip six times in half a
// minute.
var MATCH_TOLERANCE_M = 30;

// Which waypoint of the selected route we are heading for, and what
// the stored route says about it.
var wpIndex = -1;
var wpDistM = 0;

// The route and the waypoint share one logged output, the route in
// the thousands. A waypoint costs at least 17 characters of the 2048
// the setting holds, so no route can reach a thousand of them.
var ROUTE_WP_STRIDE = 1000;
var destDistM = 0;

// Set while the pilot has stepped the waypoint by hand, and held
// until the route agrees with them. The watch keeps naming the one
// it decided on, so without this the next tick would put its choice
// straight back.
var wpManual = 0;

// How far off the leg from a to b we are, in meters.
//
// The leg is measured flat, in a frame taken at our own latitude,
// which over any leg an aircraft flies is worth well under a meter.
// A position short of the start or past the end measures to that
// end, so a route is a chain of corridors rather than a set of
// endless lines.
var offLeg = function(lat, lon, a, b) {
  var mPerDegLon = M_PER_DEG_LAT * Math.cos(toRad(lat));
  var px = (lon - a.lon) * mPerDegLon;
  var py = (lat - a.lat) * M_PER_DEG_LAT;
  var bx = (b.lon - a.lon) * mPerDegLon;
  var by = (b.lat - a.lat) * M_PER_DEG_LAT;
  var span = bx * bx + by * by;
  var u = 0;
  if (span > 0) {
    u = (px * bx + py * by) / span;
    if (u < 0) {
      u = 0;
    }
    if (u > 1) {
      u = 1;
    }
  }
  var dx = px - u * bx;
  var dy = py - u * by;
  return Math.sqrt(dx * dx + dy * dy);
};

// Which waypoint the route says we are heading for, from where we
// are and nothing else.
//
// The leg we are nearest to is the leg we are flying, so its far end
// is the waypoint. Asking the question this way answers it the same
// whatever happened before, which is what an event driven rule
// cannot do: that one asks whether a waypoint has just been passed,
// and any answer it gets wrong stays wrong for the rest of the
// flight. One walk spent nine minutes pointing at a waypoint left
// behind for exactly that reason.
//
// Before the first waypoint there is no leg to be on, so the run in
// to it counts as one. The departure field is not usually overflown.
var nearestTarget = function(lat, lon) {
  var wps = routes[routeChosen].wps;
  var best = 0;
  var bestOff = haversineDistance(lat, lon, wps[0].lat, wps[0].lon);
  for (var i = 0; i + 1 < wps.length; i++) {
    var off = offLeg(lat, lon, wps[i], wps[i + 1]);
    if (off < bestOff) {
      bestOff = off;
      best = i + 1;
    }
  }
  if (wpIndex > 0 && best !== wpIndex) {
    var hold = offLeg(lat, lon, wps[wpIndex - 1], wps[wpIndex]);
    if (hold - bestOff < LEG_MARGIN_M) {
      return wpIndex;
    }
  }
  return best;
};

// Head for another waypoint, from wherever the decision came from.
var setWaypoint = function(i) {
  wpIndex = i;
};

// Move to another waypoint of the route, by hand.
//
// The pilot overrules the sequence here: cutting a leg, or going
// back to a point to re-fly it. Their choice holds until the watch
// comes round to the same waypoint.
var stepWaypoint = function(delta) {
  if (routeChosen < 0 || !routes[routeChosen].wps.length) {
    return;
  }
  var last = routes[routeChosen].wps.length - 1;
  var next = wpIndex < 0 ? (delta > 0 ? 0 : last) : wpIndex + delta;
  if (next < 0) {
    next = 0;
  }
  if (next > last) {
    next = last;
  }
  if (next === wpIndex) {
    return;
  }
  setWaypoint(next);
  wpManual = 1;
  showWaypointName();
};

// Distance from one waypoint of the route to the end of it, following
// the legs rather than the straight line.
var legsToEnd = function(route, from) {
  var total = 0;
  for (var i = from; i + 1 < route.wps.length; i++) {
    total += haversineDistance(route.wps[i].lat, route.wps[i].lon,
      route.wps[i + 1].lat, route.wps[i + 1].lon);
  }
  return total;
};

// Follow the selected route.
//
// While the watch is naming a waypoint its distance says which one,
// to the meter, so the stored route is matched against it, but only
// to confirm the waypoint we are on or to move to the next one. The
// rest of the time, which in flight is nine tenths of it, the leg we
// are nearest to decides.
var followRoute = function(lat, lon, nativeDist) {
  var route = routes[routeChosen];
  var quiet = nativeDist === undefined || nativeDist === null;
  var guided = 0;
  var i;

  if (!quiet) {
    var held = wpIndex < 0 ? -1 : Math.abs(haversineDistance(lat, lon,
      route.wps[wpIndex].lat, route.wps[wpIndex].lon) - nativeDist);
    if (held >= 0 && held < MATCH_TOLERANCE_M) {
      // The watch still explains the waypoint we are on, so a better
      // looking match elsewhere is noise. If the pilot had stepped
      // here by hand, the watch has now come round to it.
      wpManual = 0;
      guided = 1;
    } else if (!wpManual) {
      var best = -1;
      var bestGap = 0;
      var nextGap = -1;
      for (i = 0; i < route.wps.length; i++) {
        var gap = Math.abs(haversineDistance(lat, lon,
          route.wps[i].lat, route.wps[i].lon) - nativeDist);
        if (best < 0 || gap < bestGap) {
          // The first candidate has no runner up yet. Taking its empty
          // gap as one kept the first waypoint from ever matching.
          if (best >= 0) {
            nextGap = bestGap;
          }
          best = i;
          bestGap = gap;
        } else if (nextGap < 0 || gap < nextGap) {
          nextGap = gap;
        }
      }
      // Three conditions.
      //
      // A distance that fits nothing on the route is not about this
      // route. The watch also speaks for points of interest and for
      // a navigation that is not the one we carry.
      //
      // A distance that fits two waypoints equally well names
      // neither of them. One measurement is a circle around us, and
      // where the route doubles back the circle cuts it twice. Taking
      // the better of two near ties sent the screen round four
      // waypoints of a small loop in two minutes. A route of one
      // waypoint has no runner up and nothing to confuse it with.
      //
      // And the watch may only move us on to the next waypoint. Its
      // own navigation jumps back to waypoints already passed, and in
      // the first flight four of the five jumps shown en route were
      // the app following it there. Where we are is judged by the
      // geometry below, which the watch is not allowed to overrule
      // backwards or forwards past the next.
      if (best >= 0 && bestGap < MATCH_TOLERANCE_M &&
          (nextGap < 0 || nextGap - bestGap >= MATCH_TOLERANCE_M) &&
          (wpIndex < 0 || best === wpIndex + 1)) {
        if (best !== wpIndex) {
          setWaypoint(best);
        }
        guided = 1;
      }
    }
  }

  // With nothing to go on from the watch, the route's own geometry
  // says where we are on it. A waypoint the pilot chose by hand
  // holds until the geometry comes round to the same one.
  if (!guided) {
    var target = nearestTarget(lat, lon);
    if (wpManual) {
      if (target === wpIndex) {
        wpManual = 0;
      }
    } else if (target !== wpIndex) {
      setWaypoint(target);
    }
  }

  if (wpIndex < 0) {
    return;
  }
  wpDistM = haversineDistance(lat, lon,
    route.wps[wpIndex].lat, route.wps[wpIndex].lon);
  destDistM = wpDistM + legsToEnd(route, wpIndex);
};

// What the buttons send. The down button's click is a lap, which the
// template makes itself and never sends here, except while the route
// banner is up. The route is stepped the way the waypoint is, a click
// forward and a hold back.
//
//   down, clicked the next route of the round, banner up
//   up, clicked   the next waypoint, cutting the leg
//   up, held      the waypoint before, to fly it again
//   down, hold    sent when a hold begins with the banner down: open
//     begun       a round and show the route being followed
//   down, held    the route before in the round, banner up
var EVENT_NEXT_ROUTE = 1;
var EVENT_NEXT_WP = 2;
var EVENT_PREV_WP = 3;
var EVENT_OPEN_ROUND = 4;
var EVENT_PREV_ROUTE = 5;

// The route name is shown large across the dial for a moment when the
// selection changes. A pilot pressing the button has to see which
// route it landed on, and the waypoint name alone does not say.
//
// The two halves live where each of them works. The text comes from
// here through setText, which v3 established and which an <eval>
// could not do, since outputs carry numbers and the template has no
// copy of the route list. Raising and lowering the banner is the
// template's, because setStyle does not answer from here.
//
// Writing the name into the waypoint row instead was tried, to be rid
// of the second half. It works and it is wrong: the row that says
// where you are going is not the place to put something else, even
// for two seconds.
var sourceLive = 0;

// The status output packs several small values into one slot.
//
// Slots are capped at twenty and bits are not. The ceiling is 24 bits
// rather than 32: outputs travel as float32, which the FIT field
// descriptors confirm with base type 136, and a float32 counts whole
// numbers exactly only up to 16777215. Seven bits are used here.
//
// Keep in step with the template, which declares the same layout.
//
//   bit  0     the watch is still naming the waypoint
//   bits 2-6   how many routes are carried
var FLAG_SOURCE_LIVE = 1;
var SHIFT_ROUTE_COUNT = 2;
var COUNT_MASK = 31;

var packStatus = function() {
  var bits = 0;
  if (sourceLive) {
    bits += FLAG_SOURCE_LIVE;
  }
  bits += (routes === null ? 0 : routes.length & COUNT_MASK) <<
    SHIFT_ROUTE_COUNT;
  return bits;
};

// A coordinate in degrees as DD mm ss.xx with its hemisphere.
//
// Everything is carried in hundredths of an arc second and split from
// there, so a value that rounds up to a full second or a full minute
// carries into the field above instead of printing 60.
//
// The position is written from here rather than bound in the
// template, because the manifest already delivers it as int32 degrees
// times 1e7, eleven millimeters, which makes the hundredth of a
// second real. Reading the coordinate object from the template worked
// but had to be guessed at first, and left the screen needing a
// heartbeat of its own to do the writing.
var pad = function(n, width) {
  var s = '' + n;
  while (s.length < width) {
    s = '0' + s;
  }
  return s;
};

var dms = function(value, isLat) {
  if (value === undefined || value === null) {
    return '--';
  }
  var side = value < 0 ? (isLat ? 'S' : 'W') : (isLat ? 'N' : 'E');
  var left = Math.round(Math.abs(value) * 360000);
  var cs = left % 100;
  left = (left - cs) / 100;
  var s = left % 60;
  left = (left - s) / 60;
  var m = left % 60;
  var d = (left - m) / 60;
  return pad(d, isLat ? 2 : 3) + '\u00b0' + pad(m, 2) + '\u0027' +
    pad(s, 2) + '.' + pad(cs, 2) + '\u0022' + side;
};

var shownPosLat = '';
var shownPosLon = '';

var showPosition = function(lat, lon) {
  var latText = dms(lat, 1);
  var lonText = dms(lon, 0);
  if (latText !== shownPosLat) {
    shownPosLat = latText;
    try {
      setText('#posLat', latText);
    } catch (e) {
    }
  }
  if (lonText !== shownPosLon) {
    shownPosLon = lonText;
    try {
      setText('#posLon', lonText);
    } catch (e) {
    }
  }
};

var shownWpName = '';

// Raised once the banner has been given a route to show, so the
// opening guess is made once and not every second.
var routeNamed = 0;

// The order the routes are offered in, as indices into routes, and
// where in it the chosen one sits.
var routeOrder = [];
var routeRank = 0;

// Write route i into the banner, NO_ROUTE included, rank being its
// place in the order it is offered in. The count includes the choice
// of no route.
var nameRoute = function(i, rank) {
  try {
    // Two lines in the one element: the name, then where it sits in
    // the order, so a pilot stepping through them knows whether there
    // is more to come or it has wrapped. The template is what keeps
    // the newline.
    setText('#routeBanner',
      (i === NO_ROUTE ? NO_ROUTE_NAME : routes[i].name) + '\n' +
      (rank + 1) + '/' + (routes.length + 1));
  } catch (e) {
  }
};

var showRouteName = function() {
  nameRoute(routeChosen, routeRank);
};

// Write the waypoint's name when it changes. A stored route carries
// its own names, so the screen no longer depends on the watch still
// naming one. With no route, or no waypoint yet, the row says so
// rather than keeping the name of a route no longer followed.
var showWaypointName = function() {
  var name = NO_ROUTE_NAME;
  if (routeChosen !== NO_ROUTE && wpIndex >= 0) {
    name = routes[routeChosen].wps[wpIndex].name;
  }
  if (name === shownWpName) {
    return;
  }
  shownWpName = name;
  try {
    setText('#wptName', name);
  } catch (e) {
  }
};

// Distance from where we are to the nearest waypoint of a route.
var routeDistance = function(route, lat, lon) {
  var best = -1;
  for (var j = 0; j < route.wps.length; j++) {
    var d = haversineDistance(lat, lon, route.wps[j].lat, route.wps[j].lon);
    if (best < 0 || d < best) {
      best = d;
    }
  }
  return best;
};

// Indices of every route, nearest first. Without a position, the
// order of the list.
//
// Sorted by insertion here rather than with Array.sort, whose
// stability the engine does not promise. It matters: two routes
// leaving the same field are exactly as near, and the first of the
// list has to come first every time.
var orderRoutes = function(lat, lon) {
  var order = [];
  var dist = [];
  for (var i = 0; i < routes.length; i++) {
    var d = lat === undefined ? i : routeDistance(routes[i], lat, lon);
    var k = order.length;
    while (k > 0 && dist[k - 1] > d) {
      order[k] = order[k - 1];
      dist[k] = dist[k - 1];
      k--;
    }
    order[k] = i;
    dist[k] = d;
  }
  return order;
};

// Open a round of choosing: the route being followed first, then
// every other one nearest first, then no route at all.
//
// Every route is offered, however far. A diversion is chosen exactly
// when none of its waypoints is near, so a filter by distance would
// hide the one route the pilot needs most.
//
// The order is taken here and frozen for the round. Sorted afresh at
// every press it would reshuffle in flight between two presses, and a
// route could be skipped or offered twice. Starting from the route
// being followed means the first step offers the nearest other one,
// and wrapping comes back to where it began. No route comes last, so
// it is one hold back from the start of a round.
var openRound = function(lat, lon) {
  var order = orderRoutes(lat, lon);
  routeOrder = [routeChosen];
  for (var k = 0; k < order.length; k++) {
    if (order[k] !== routeChosen) {
      routeOrder.push(order[k]);
    }
  }
  if (routeChosen !== NO_ROUTE) {
    routeOrder.push(NO_ROUTE);
  }
  routeRank = 0;
};

// Step through the round, delta being 1 for the next route and -1 for
// the one before, wrapping at both ends.
var stepRoute = function(lat, lon, delta) {
  // A step before any round was opened, the opening event having
  // been lost, opens one rather than stepping through nothing.
  if (routeOrder.length !== routes.length + 1) {
    openRound(lat, lon);
  }
  var n = routeOrder.length;
  routeRank = (routeRank + delta + n) % n;
  routeChosen = routeOrder[routeRank];
  routeSettled = 1;
};

// Propose the route with a waypoint closest to where we are.
//
// Only a proposal, made once. Two routes leaving the same field are
// equally close, the first of the list wins, and it is the pilot who
// knows which one is being flown.
var chooseRoute = function(lat, lon) {
  routeOrder = orderRoutes(lat, lon);
  routeOrder.push(NO_ROUTE);
  routeRank = 0;
  routeChosen = routeOrder[0];
  routeSettled = 1;
};

// The leg being solved: where the current waypoint is, worked out
// from nothing but the distances the watch reports on the way to it.
//
// WHY it is a set of running sums and not a list of samples. Each
// reading says the waypoint lies on a circle: (X-x)^2 + (Y-y)^2 = d^2
// for our position x,y and its distance d. That is not linear in the
// unknown X,Y, but subtracting the first reading's circle from every
// later one cancels the squared unknowns and leaves a straight line
// per sample:
//
//     a*X + b*Y = c
//
// with a and b twice our travel since the first sample and c what the
// distances and that travel imply, so a sample at (x, y) measuring d
// contributes 2*x*X + 2*y*Y = x^2 + y^2 - d^2 + d0^2. Least squares
// over those lines is a two by two system, and a two by two system
// needs only the six sums of products below. So a leg of any length
// costs six numbers and one inverse, and nothing is buffered, which
// matters on a watch that runs this once a second and gives a feature
// very little room.
//
// The same matrix also gives the spread of the answer, and that
// matters more than the answer. Flying straight at a waypoint leaves
// the lines nearly parallel, the system close to singular and the fix
// free to slide along the line of flight. The screen has to know that
// rather than draw a confident wrong arrow.
//
// The fields:
//
//   lat0, lon0, dist0  the first sample of the leg. Everything else
//                      is measured from it, since that subtraction is
//                      what made the problem linear.
//   mPerDegLon         meters per degree of longitude at lat0, so the
//                      leg can be worked in a flat frame.
//   saa sab sbb        the normal matrix of the fit, summed over
//                      samples: sum of a*a, a*b, b*b.
//   sac sbc            the right hand side: sum of a*c and b*c.
//   scc                sum of c*c, which is only needed to recover
//                      how badly the samples disagree.
//   count              samples kept. Under eight, no answer is given.
//   maxDist            the largest distance seen, which sets the
//                      floor on how precise the answer may claim to
//                      be.
//   scale              how far the samples miss the fitted point, in
//                      the units the sums are in. It turns the shape
//                      of the fit into a distance.
//   strikes            consecutive readings the current answer cannot
//                      explain. Enough of them and the leg restarts.
//   lastLat, lastLon   the last sample kept, so a standing still one
//                      can be dropped.
//   lat, lon           the answer, or undefined while there is none.
//   sigmaM             how wrong the answer is likely to be, in
//                      meters.
//
// On sigma, since it appears throughout: it is the standard deviation
// of an estimate, the usual one sigma. A fix with a sigma of 30 m is
// one whose true position is within 30 m about two thirds of the
// time, and within 90 m almost always, which is why three sigmas is
// the allowance used before a reading is called a contradiction.
// bearingSigmaRad is the same idea turned into an angle: the part of
// that spread lying across the line of sight, divided by the distance
// to the waypoint.
//
// Plain object and plain functions on purpose. Constructors and
// prototypes are not used by any feature known to run on this watch,
// and a build of this file that used them would not start at all.
var fix = {
  lat0: 0, lon0: 0, dist0: 0, mPerDegLon: 0,
  saa: 0, sab: 0, sbb: 0, sac: 0, sbc: 0, scc: 0,
  count: 0, maxDist: 0, strikes: 0, scale: 0,
  lastLat: 0, lastLon: 0,
  lat: undefined, lon: undefined, sigmaM: undefined
};

// Start a new leg from a first sample. All sums are relative to it.
var fixReset = function(lat, lon, distM) {
  fix.lat0 = lat;
  fix.lon0 = lon;
  fix.dist0 = distM;
  fix.mPerDegLon = M_PER_DEG_LAT * Math.cos(toRad(lat));
  fix.saa = 0;
  fix.sab = 0;
  fix.sbb = 0;
  fix.sac = 0;
  fix.sbc = 0;
  fix.scc = 0;
  fix.count = 0;
  fix.maxDist = distM;
  fix.strikes = 0;
  fix.scale = 0;
  fix.lastLat = lat;
  fix.lastLon = lon;
  fix.lat = undefined;
  fix.lon = undefined;
  fix.sigmaM = undefined;
};

// Fold one more measurement into the running sums, unless it was
// taken from where the last one was.
var fixAdd = function(lat, lon, distM) {
  if (haversineDistance(fix.lastLat, fix.lastLon, lat, lon) < MIN_STEP_M) {
    return;
  }
  fix.lastLat = lat;
  fix.lastLon = lon;

  var x = (lon - fix.lon0) * fix.mPerDegLon;
  var y = (lat - fix.lat0) * M_PER_DEG_LAT;
  var a = 2 * x;
  var b = 2 * y;
  var c = x * x + y * y - distM * distM + fix.dist0 * fix.dist0;

  fix.saa += a * a;
  fix.sab += a * b;
  fix.sbb += b * b;
  fix.sac += a * c;
  fix.sbc += b * c;
  fix.scc += c * c;
  fix.count += 1;
  if (distM > fix.maxDist) {
    fix.maxDist = distM;
  }
};

// Solve for the waypoint and its spread, leaving both undefined while
// the geometry cannot support an answer.
var fixSolve = function() {
  fix.lat = undefined;
  fix.lon = undefined;
  fix.sigmaM = undefined;
  if (fix.count < 8) {
    return;
  }
  var det = fix.saa * fix.sbb - fix.sab * fix.sab;
  if (det <= 0) {
    return;
  }
  var x = (fix.sbb * fix.sac - fix.sab * fix.sbc) / det;
  var y = (fix.saa * fix.sbc - fix.sab * fix.sac) / det;

  // Spread from the same normal matrix that produced the answer,
  // scaled by how well the samples actually agree with it. The floor
  // keeps a handful of samples along a straight line from claiming
  // more than the measurement noise allows.
  var rss = x * x * fix.saa + 2 * x * y * fix.sab + y * y * fix.sbb -
    2 * x * fix.sac - 2 * y * fix.sbc + fix.scc;
  if (rss < 0) {
    rss = 0;
  }
  var residual = Math.sqrt(rss / (fix.count - 2));
  var floor = 2 * fix.maxDist * DIST_SIGMA_M;
  fix.scale = Math.max(residual, floor);
  fix.sigmaM = fix.scale * Math.sqrt((fix.saa + fix.sbb) / det);
  fix.lat = fix.lat0 + y / M_PER_DEG_LAT;
  fix.lon = fix.lon0 + x / fix.mPerDegLon;
};

// How uncertain the bearing to the fix is, in radians, from where we
// stand now.
//
// The covariance of the fix is the inverse of the same normal matrix,
// scaled by the residual. Projecting it across the line of sight and
// dividing by the distance gives an angle, which is the quantity the
// screen actually has to be honest about.
var fixBearingSigma = function(lat, lon, distM) {
  if (fix.lat === undefined || !(distM > 0)) {
    return undefined;
  }
  var det = fix.saa * fix.sbb - fix.sab * fix.sab;
  if (det <= 0) {
    return undefined;
  }
  var dx = (fix.lon - lon) * M_PER_DEG_LAT * Math.cos(toRad(lat));
  var dy = (fix.lat - lat) * M_PER_DEG_LAT;
  var norm = Math.sqrt(dx * dx + dy * dy);
  if (norm <= 0) {
    return undefined;
  }
  var ux = -dy / norm;
  var uy = dx / norm;
  var varPerp = (fix.scale * fix.scale / det) *
    (ux * ux * fix.sbb - 2 * ux * uy * fix.sab + uy * uy * fix.saa);
  if (varPerp < 0) {
    varPerp = 0;
  }
  return Math.sqrt(varPerp) / distM;
};

var lastConfirmedIdx;
var lastWpLat, lastWpLon, lastWpDistM, lastWpTimeS;
var speedMps = 0;
var trackRad = 0;

// Decide whether the native distance now refers to a different
// waypoint than the one being solved. Returns true when the leg has
// to start over.
var waypointChanged = function(lat, lon, distM, nowS) {
  if (lastWpDistM === undefined) {
    return true;
  }
  if (nowS - lastWpTimeS > STALE_WP_S) {
    // The feed went quiet, which happens off route. Without a
    // baseline the travel rule says nothing, so ask instead whether
    // the waypoint we already know still explains what we are told.
    if (fix.lat === undefined) {
      return true;
    }
    var ours = haversineDistance(lat, lon, fix.lat, fix.lon);
    return Math.abs(ours - distM) >
      RESYNC_TOLERANCE_M + INNOVATION_SIGMAS * fix.sigmaM;
  }
  var moved = haversineDistance(lastWpLat, lastWpLon, lat, lon);
  return Math.abs(distM - lastWpDistM) > moved + SWITCH_MARGIN_M;
};

// Ask whether the measurement the watch just gave contradicts the
// waypoint we believe in. Repeated disagreement, rather than a single
// one, is what condemns the fix, so a noisy sample cannot throw away
// a good leg.
var contradicted = function(lat, lon, distM) {
  if (fix.lat === undefined) {
    return false;
  }
  var ours = haversineDistance(lat, lon, fix.lat, fix.lon);
  var allowed = INNOVATION_M + INNOVATION_SIGMAS * fix.sigmaM;
  if (Math.abs(ours - distM) <= allowed) {
    fix.strikes = 0;
    return false;
  }
  fix.strikes += 1;
  return fix.strikes >= INNOVATION_STRIKES;
};

// The fixes the ground track is measured over, oldest first.
var trackSamples = [];

// Ground speed and track, from a window of fixes rather than from
// two of them.
//
// A baseline that is reset when it is used leaves the track frozen
// between resets and stepping when they come. A window that slides
// answers every tick.
//
// Inside the window a straight line is fitted through the fixes by
// least squares, in a flat frame taken at the newest one, and its
// slope is the velocity. Every fix in the window counts, where
// subtracting the two ends would throw the middle away and keep all
// the noise of the two that are left. Over n fixes that is about the
// square root of n / 6 better.
var updateGroundTrack = function(lat, lon, nowS) {
  var n = trackSamples.length;
  if (n === 0 || nowS > trackSamples[n - 1].t) {
    trackSamples.push({ t: nowS, lat: lat, lon: lon });
  }
  while (trackSamples.length > 1 &&
         nowS - trackSamples[0].t > TRACK_WINDOW_S) {
    trackSamples.shift();
  }
  n = trackSamples.length;
  if (n < 2) {
    return;
  }

  // Reach back only as far as the baseline needs, so a fast leg
  // answers at once and a slow one averages until it has something
  // to average.
  var last = trackSamples[n - 1];
  var start = 0;
  var i;
  for (i = n - 2; i >= 0; i--) {
    start = i;
    if (haversineDistance(trackSamples[i].lat, trackSamples[i].lon,
        last.lat, last.lon) >= TRACK_BASELINE_M) {
      break;
    }
  }

  var mPerDegLon = M_PER_DEG_LAT * Math.cos(toRad(lat));
  var st = 0, stt = 0, sx = 0, sy = 0, sxt = 0, syt = 0, k = 0;
  for (i = start; i < n; i++) {
    var s = trackSamples[i];
    var dt = s.t - last.t;
    var x = (s.lon - last.lon) * mPerDegLon;
    var y = (s.lat - last.lat) * M_PER_DEG_LAT;
    st += dt;
    stt += dt * dt;
    sx += x;
    sy += y;
    sxt += x * dt;
    syt += y * dt;
    k += 1;
  }
  var den = k * stt - st * st;
  if (den <= 0) {
    return;
  }
  var vx = (k * sxt - st * sx) / den;
  var vy = (k * syt - st * sy) / den;
  var speed = Math.sqrt(vx * vx + vy * vy);
  if (speed > MAX_PLAUSIBLE_SPEED_MPS) {
    return;
  }
  speedMps = speed;
  if (speed > MOVING_MPS) {
    trackRad = Math.atan2(vx, vy);
  }
};

function evaluate(input, output) {
  // Reading the routes needs no position, so it happens before the
  // guards below. Otherwise nothing at all appears indoors, and the
  // two things worth checking on a desk, that storage answers and
  // that the routes parse, are exactly the two that do not need a
  // sky view.
  loadRoutes();
  output.status = packStatus();

  // Name a route on the first pass, before a fix, so the banner that
  // is already up at startup has a route on it rather than the app's
  // own name. The first of the list is the only one that can be
  // named with no position to judge by, and the choice by proximity
  // below replaces it as soon as the sky is in view.
  if (!routeNamed && routes.length) {
    routeNamed = 1;
    nameRoute(0, 0);
  }

  if (input.lat === undefined || input.lon === undefined ||
      input.activityTime === undefined) {
    return;
  }

  // With no fix the watch reports a position of 0/0 rather than
  // nothing, which would silently turn every derived value into
  // rubbish. Qualify the position by the readiness reading.
  if (input.readiness !== 100) {
    return;
  }


  var lat = input.lat / 1e7;
  var lon = input.lon / 1e7;

  if (!routeSettled && routes.length) {
    chooseRoute(lat, lon);
    showRouteName();
  }
  var nowS = input.activityTime;

  updateGroundTrack(lat, lon, nowS);

  if (input.wpDist !== undefined && input.wpDist !== null) {
    if (waypointChanged(lat, lon, input.wpDist, nowS) ||
        contradicted(lat, lon, input.wpDist)) {
      fixReset(lat, lon, input.wpDist);
    } else {
      fixAdd(lat, lon, input.wpDist);
      fixSolve();
    }
    lastWpLat = lat;
    lastWpLon = lon;
    lastWpDistM = input.wpDist;
    lastWpTimeS = nowS;
    lastConfirmedIdx = input.closest;
  } else if (fix.lat !== undefined && lastConfirmedIdx !== undefined &&
      input.closest !== undefined &&
      input.closest - lastConfirmedIdx >= STALE_INDEX_STEP) {
    // The watch has gone quiet but says we have moved on along the
    // route, so the waypoint we are holding is behind us.
    fixReset(lat, lon, 0);
    lastWpDistM = undefined;
  }

  // A selected route knows where every waypoint is, so distance,
  // bearing and what is left to the destination all come from it and
  // none of them depends on the watch still talking. Without one,
  // the solver's fix is all there is and only the current leg can be
  // described.
  var distM;
  var targetLat;
  var targetLon;
  output.destDistM = undefined;
  if (routeChosen !== NO_ROUTE) {
    followRoute(lat, lon, input.wpDist);
    if (wpIndex >= 0) {
      distM = wpDistM;
      targetLat = routes[routeChosen].wps[wpIndex].lat;
      targetLon = routes[routeChosen].wps[wpIndex].lon;
      output.destDistM = destDistM;
    }
  } else if (input.wpDist !== undefined && input.wpDist !== null) {
    distM = input.wpDist;
  } else if (fix.lat !== undefined) {
    distM = haversineDistance(lat, lon, fix.lat, fix.lon);
  }
  showWaypointName();

  // Passed through for the record: the one route value still live off
  // route, and what a replay needs to rebuild the stale fix rule.
  output.closestIdx = input.closest;

  // Logged because a replay cannot rebuild it: the buttons move both
  // the route and the waypoint, and no press is recorded. Read 2003
  // as waypoint 3 of route 2, counting from zero, and -1 as no route
  // chosen, which the pilot can pick.
  output.routeWp = undefined;
  if (routeChosen === NO_ROUTE) {
    output.routeWp = NO_ROUTE;
  } else if (wpIndex >= 0) {
    output.routeWp = routeChosen * ROUTE_WP_STRIDE + wpIndex;
  }

  // Whether this tick's numbers come from the watch or from our own
  // memory of a waypoint it has stopped talking about. The screen has
  // to say which, because the two look identical otherwise and only
  // one of them is being confirmed by anything.
  sourceLive = (input.wpDist === undefined ||
    input.wpDist === null) ? 0 : 1;
  output.status = packStatus();

  // Logged apart from legDistM, which falls back to our own
  // computation when the watch goes quiet and so cannot be fed back
  // into the replay tool as a measurement.
  output.nativeDistM = input.wpDist;
  output.legDistM = distM;
  output.trackRad = trackRad;
  output.speedMps = speedMps;
  output.fixLat = fix.lat;
  output.fixLon = fix.lon;

  showPosition(lat, lon);

  // Cleared first, and every time.
  //
  // An output that is simply not assigned keeps the value it had,
  // which on a navigation screen means a confident arrow pointing at
  // a waypoint left behind minutes ago. Assigning undefined is what
  // empties it. The first field test of this app showed both
  // behaviours side by side: distance and spread went blank off
  // route while bearing and deviation stayed frozen.
  output.legBearingRad = undefined;
  output.deviationRad = undefined;
  output.bearingSigmaRad = undefined;

  if (targetLat !== undefined) {
    // A stored waypoint is known exactly, so there is nothing to
    // withhold and no spread to report.
    output.bearingSigmaRad = 0;
    var storedBearing = bearingTo(lat, lon, targetLat, targetLon);
    output.legBearingRad = storedBearing;
    output.deviationRad = normalizeSignedAngle(storedBearing - trackRad);
  } else {
    var bearingSigma = fixBearingSigma(lat, lon, distM);
    output.bearingSigmaRad = bearingSigma;
    if (bearingSigma !== undefined &&
        bearingSigma <= MAX_BEARING_ERROR_RAD) {
      var bearingRad = bearingTo(lat, lon, fix.lat, fix.lon);
      output.legBearingRad = bearingRad;
      // Positive means the waypoint is clockwise of the current
      // track, so turn right. Negative means turn left.
      output.deviationRad = normalizeSignedAngle(bearingRad - trackRad);
    }
  }

  output.legEteS = undefined;
  output.destEteS = undefined;
  if (speedMps > MOVING_MPS) {
    if (distM !== undefined) {
      output.legEteS = distM / speedMps;
    }
    if (wpIndex >= 0 && routeChosen >= 0) {
      output.destEteS = destDistM / speedMps;
    }
  }
}

// A button was pressed. See the event constants above for which.
function onEvent(input, output, eventId) {
  loadRoutes();

  if (eventId === EVENT_NEXT_WP || eventId === EVENT_PREV_WP) {
    stepWaypoint(eventId === EVENT_NEXT_WP ? 1 : -1);
    output.status = packStatus();
    return;
  }
  if (eventId !== EVENT_NEXT_ROUTE && eventId !== EVENT_PREV_ROUTE &&
      eventId !== EVENT_OPEN_ROUND) {
    return;
  }

  // A position without a fix is 0/0, and ordering by distance from
  // there is noise. Without one the list keeps its own order, which
  // is also how it gets checked on a desk.
  var lat;
  var lon;
  if (input.readiness === 100 && input.lat !== undefined &&
      input.lon !== undefined) {
    lat = input.lat / 1e7;
    lon = input.lon / 1e7;
  }

  // Opening a round changes nothing: it only says which route is
  // being followed, so the hold that opens it is a look and not a
  // choice.
  if (eventId === EVENT_OPEN_ROUND) {
    openRound(lat, lon);
    showRouteName();
    return;
  }

  stepRoute(lat, lon, eventId === EVENT_NEXT_ROUTE ? 1 : -1);
  setWaypoint(-1);
  wpManual = 0;
  showRouteName();
  showWaypointName();
  output.status = packStatus();
}

function getUserInterface(input, output) {
  return { template: "nav" };
}
