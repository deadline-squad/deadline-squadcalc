/*
 * Independent flight oracle for the calculator's solver: flies a shot at a given barrel elevation through the
 * game's discrete model and reports where it crosses a given horizontal distance. It shares no code with the
 * calculator and reads none of it; the test (tests/independentFlight.test.mjs) hands it the elevations the
 * calculator solved and judges how far the flights miss their targets.
 *
 * The model is the game's own, as the module docstring of Squad Ballistics (ballistics.py, lines 17-63 and 88)
 * writes it and the thesis states it (formulas F1 to F5 of docs/thesis-methods-and-results.md):
 *   - one step per server frame, FRAME_TIME = 1 / 49.87 s = 20.052 ms (F1);
 *   - velocity Verlet with a lagging rotation (F3): the move uses the velocity of the rotation of the step
 *     before, then the rotation follows the velocity (or keeps the barrel's axis), then the velocity is set
 *     from the new rotation, the speed capped to `cap` on every step, the first one included;
 *   - the motor acts on N = ceil(T / dt) - 1 steps (F2, docstring lines 49-61), not on the ceil(T / dt) steps
 *     that start before T;
 *   - the projectile starts at the muzzle, f along the barrel and u above its axis from the pivot, h above the
 *     ground (F5).
 *
 * usage: fly specs.txt cases.txt > flights.txt
 * specs.txt, one shot per line:   sid v0 g a T cap follows h f u
 * cases.txt, one flight per line: sid theta distance height
 * flights.txt, one line per case, in order:   ok dy t slope
 * The formats are documented in README.md.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#define FRAME_TIME (1.0 / 49.87)

/* Most shots a specs file may hold, and most frames a flight may take before it is given up */
#define MAX_SPECS 1024
#define MAX_FRAMES 2000000L

/* A flight whose horizontal velocity is not positive after this many frames never reaches the target */
#define TURN_BACK_FRAMES 100

typedef struct {
    int defined;
    double v0, g, a, T, cap;
    int follows;
    double h, f, u;
} Spec;

typedef struct {
    int ok;
    double dy, t, slope;
} Flight;

static Spec specs[MAX_SPECS];

/* clamp_V of F3: the vector limited to the speed `cap` (0: no cap) */
static void clamp(double cap, double *vx, double *vy) {
    double speed = hypot(*vx, *vy);
    if (cap > 0 && speed > cap) {
        *vx *= cap / speed;
        *vy *= cap / speed;
    }
}

/* Flight of shot `s` fired at elevation `theta` radians: the height above the target (`dy`, m), the time since
 * launch (`t`, s) and the slope of the chord (`slope`) where it crosses `distance` m from the pivot; the target
 * is `height` m above the pivot's ground. Not ok when the launch point is already past the distance or the
 * projectile turns back. */
static Flight fly(const Spec *s, double theta, double distance, double height) {
    const double dt = FRAME_TIME;
    const double c = cos(theta), sn = sin(theta);
    const double x0 = s->f * c - s->u * sn;
    const double y0 = s->h + s->f * sn + s->u * c;
    /* N of F2 */
    const long motor_frames = (s->a != 0 && s->T > 0) ? (long)ceil(s->T / dt) - 1 : 0;
    double x = x0, y = y0, vx = s->v0 * c, vy = s->v0 * sn;
    double rx = c, ry = sn;
    Flight flight = {0, 0, 0, 0};

    if (distance <= x0) return flight;
    for (long n = 0; n < MAX_FRAMES; n++) {
        const double chi = n < motor_frames ? 1.0 : 0.0;
        double ux = vx + chi * s->a * rx * dt;
        double uy = vy + (chi * s->a * ry - s->g) * dt;
        clamp(s->cap, &ux, &uy);
        const double nx = x + 0.5 * (vx + ux) * dt;
        const double ny = y + 0.5 * (vy + uy) * dt;
        if (s->follows) {
            const double speed = hypot(vx, vy);
            rx = vx / speed;
            ry = vy / speed;
        }
        vx += chi * s->a * rx * dt;
        vy += (chi * s->a * ry - s->g) * dt;
        clamp(s->cap, &vx, &vy);
        if (nx >= distance) {
            const double f = (distance - x) / (nx - x);
            flight.ok = 1;
            flight.dy = y + f * (ny - y) - height;
            flight.t = ((double)n + f) * dt;
            flight.slope = (ny - y) / (nx - x);
            return flight;
        }
        x = nx;
        y = ny;
        if (vx <= 0 && n > TURN_BACK_FRAMES) return flight;
    }
    return flight;
}

static FILE *open_or_die(const char *path) {
    FILE *file = fopen(path, "r");
    if (!file) {
        fprintf(stderr, "fly: cannot read %s\n", path);
        exit(1);
    }
    return file;
}

int main(int argc, char **argv) {
    char line[1024];
    FILE *spec_file, *case_file;

    if (argc != 3) {
        fprintf(stderr, "usage: fly specs.txt cases.txt > flights.txt\n");
        return 2;
    }
    spec_file = open_or_die(argv[1]);
    while (fgets(line, sizeof line, spec_file)) {
        int sid;
        Spec s;
        if (sscanf(line, "%d %lf %lf %lf %lf %lf %d %lf %lf %lf", &sid, &s.v0, &s.g, &s.a, &s.T, &s.cap,
                   &s.follows, &s.h, &s.f, &s.u) != 10 || sid < 0 || sid >= MAX_SPECS) {
            fprintf(stderr, "fly: bad spec line: %s", line);
            return 1;
        }
        s.defined = 1;
        specs[sid] = s;
    }
    fclose(spec_file);

    case_file = open_or_die(argv[2]);
    while (fgets(line, sizeof line, case_file)) {
        int sid;
        double theta, distance, height;
        Flight flight;
        if (sscanf(line, "%d %lf %lf %lf", &sid, &theta, &distance, &height) != 4 || sid < 0 || sid >= MAX_SPECS
            || !specs[sid].defined) {
            fprintf(stderr, "fly: bad case line: %s", line);
            return 1;
        }
        flight = fly(&specs[sid], theta, distance, height);
        printf("%d %.17g %.17g %.17g\n", flight.ok, flight.dy, flight.t, flight.slope);
    }
    fclose(case_file);
    return 0;
}
