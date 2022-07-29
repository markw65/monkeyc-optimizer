import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { globa, promiseAll, spawnByLine } from "./util";
import { BuildConfig } from "./optimizer-types";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type RemoteProject =
  | string
  | {
      root: string;
      options?: BuildConfig;
      rename?: { from: string; to: string }[];
      build?: boolean;
      comment?: string;
      exclude?: string;
      include?: string;
      sourcePath?: string;
      jungleContent?: string[];
    };

export const githubProjects: RemoteProject[] = [
  "https://bitbucket.org/mike_polatoglou/moonphase",
  "https://bitbucket.org/obagot/connectiq-hict",
  "https://bitbucket.org/villagehymn/marklaying",
  "https://github.com/30Wedge/SwagginNumerals",
  "https://github.com/4ch1m/HueCIQ",
  "https://github.com/DeCaPa/MyBigDate",
  "https://github.com/HanSolo/digital",
  "https://github.com/HerrRiebmann/Stretch",
  "https://github.com/HookyQR/TidyField",
  {
    root: "https://github.com/HookyQR/TidyWatch",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  {
    root: "https://github.com/Laverlin/Yet-Another-Sailing-App",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  {
    root: "https://github.com/Laverlin/Yet-Another-WatchFace",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  "https://github.com/OliverHannover/Aviatorlike",
  "https://github.com/OliverHannover/Formula_1",
  "https://github.com/Peterdedecker/connectiq",
  "https://github.com/Tkadla-GSG/garmin",
  "https://github.com/ToryStark/connect-iq",
  {
    root: "https://github.com/TrainAsONE/trainasone-connectiq",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  "https://github.com/YoungChulDK/GarminCryptoPrices",
  "https://github.com/adamml/tempo-trainer",
  "https://github.com/admsteck/ConnectIQ",
  "https://github.com/alanfischer/hassiq",
  {
    root: "https://github.com/alexphredorg/ConnectIqSailingApp",
    options: { checkInvalidSymbols: "WARNING" },
  },
  "https://github.com/andriijas/connectiq-apps",
  "https://github.com/antirez/iqmeteo",
  "https://github.com/antonioasaro/GARMIN-AMD_Watchface",
  "https://github.com/antonioasaro/Garmin-Antonio_SMS",
  "https://github.com/aronsommer/WebRequestGlance-Widget",
  "https://github.com/aronsommer/WebRequestMultiple-Widget",
  "https://github.com/axl13/PowerAdjuster",
  {
    root: "https://github.com/blaskovicz/garmin-nest-camera-control",
    rename: [{ from: "source/Env.mc.sample", to: "source/Env.mc" }],
    options: { checkInvalidSymbols: "WARNING" },
  },
  {
    root: "https://github.com/breber/helicopter-iq",
    build: false,
    comment: "missing launcher icon",
  },
  "https://github.com/breber/nest-iq",
  "https://github.com/cedric-dufour/connectiq-app-glidersk",
  "https://github.com/cedric-dufour/connectiq-app-towplanesk",
  "https://github.com/chanezgr/IQwprimebal",
  "https://github.com/chris220688/garmin-myBus-app",
  {
    root: "https://github.com/clementbarthes/GarminCogDisplay",
    exclude: "temp.monkey\\.jungle",
  },
  "https://github.com/creacominc/connectiq-PowerField",
  {
    root: "https://github.com/creacominc/connectiq-PowerFieldTests",
    jungleContent: [
      "base.sourcePath=source;../creacominc-connectiq-PowerField/source",
      "base.resourcePath=resources;../creacominc-connectiq-PowerField/resources",
    ],
  },
  "https://github.com/danielsiwiec/fitnessTimer",
  "https://github.com/danielsiwiec/tabataTimer",
  "https://github.com/danielsiwiec/waypoints-app",
  "https://github.com/danipindado/Lap-average-vertical-speed",
  "https://github.com/darrencroton/Snapshot",
  "https://github.com/darrencroton/SnapshotHR",
  "https://github.com/darrencroton/SnapshotRHR",
  "https://github.com/darrencroton/SnapshotWatch",
  "https://github.com/davedoesdemos/ConnectIQ-Watch-IoT",
  "https://github.com/dazey77/Horizontal-speedo-rep",
  {
    root: "https://github.com/dbcm/KISSFace",
    options: { checkInvalidSymbols: "WARNING" },
  },
  "https://github.com/desyat/OpenWeatherMapWidget",
  {
    root: "https://github.com/dkappler/kraken",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  "https://github.com/dmuino/HMFields",
  "https://github.com/douglasr/connectiq-logo-analog",
  "https://github.com/douglasr/connectiq-samples",
  "https://github.com/ebolefeysot/CIQ_PcvVo2max",
  "https://github.com/fhdeutschmann/ZuluTime",
  {
    root: "https://github.com/fjbenitog/bike-simulator",
    options: { checkInvalidSymbols: "WARNING" },
  },
  "https://github.com/fjbenitog/digital-watch-cas10",
  "https://github.com/fmercado/telemeter",
  {
    root: "https://github.com/garmin/connectiq-apps",
    exclude: "/barrels/|barrels.jungle",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  "https://github.com/gcormier9/GRun",
  {
    root: "https://github.com/gimportexportdevs/gimporter",
    options: { checkInvalidSymbols: "WARNING" },
  },
  "https://github.com/grafstrom/ORun",
  {
    root: "https://github.com/hakonrossebo/FootballFixtures",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  {
    root: "https://github.com/hansiglaser/ConnectIQ",
    options: { checkInvalidSymbols: "WARNING" },
  },
  "https://github.com/haraldh/SunCalc",
  {
    root: "https://github.com/imgrant/AuxHR",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  "https://github.com/imgrant/EnergyExpenditureField",
  "https://github.com/imgrant/FlexiRunner",
  "https://github.com/imgrant/RunningEconomyField",
  "https://github.com/jensws80/JSClock",
  "https://github.com/joakim-ribier/ftw-garmin",
  "https://github.com/joergsteinkamp/Simplog",
  {
    root: "https://github.com/johnnyw3/connectiq-watchapps",
    exclude: "Data Fields.TurnAroundReminder.monkey.jungle",
    comment: "Has syntax errors",
    sourcePath: "source",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  "https://github.com/jonasbcdk/CleanSteps",
  "https://github.com/kolyuchii/TravelCalc",
  "https://github.com/kopa/BikersField",
  "https://github.com/kopa/RunnersField",
  {
    root: "https://github.com/kromar/garmin_fenix3",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  "https://github.com/landnavapp/LandNavApp",
  "https://github.com/lcj2/ciq_binarywatch",
  "https://github.com/lcj2/ciq_monkeyfuel",
  "https://github.com/lucamrod/TriathlonDuathlonAquathlon",
  "https://github.com/lukasz-duda/NormalizedPoolDistance",
  "https://github.com/matco/badminton",
  {
    root: "https://github.com/matmuc/SportMonitor",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  "https://github.com/matthiasmullie/connect-iq-datafield-accurate-pace",
  "https://github.com/matthiasmullie/connect-iq-datafield-calories-equivalent",
  "https://github.com/mettyw/activity_view",
  "https://github.com/miss-architect/garmin-squash",
  {
    root: "https://github.com/mrfoto/ForecastLine",
    build: false,
    comment: "Missing a 'secrets' file",
  },
  "https://github.com/myneur/HeartRateRunner",
  {
    root: "https://github.com/myneur/late",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  "https://github.com/okdar/smartarcs",
  "https://github.com/pedlarstudios/WordOfTheDay",
  {
    root: "https://github.com/psjo/arcsin",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  {
    root: "https://github.com/psjo/darktimes",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  {
    root: "https://github.com/psjo/dotter",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  {
    root: "https://github.com/psjo/felt",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  "https://github.com/rain-dl/DayRound",
  "https://github.com/ravenfeld/Connect-IQ-DataField-BackToHome",
  "https://github.com/ravenfeld/Connect-IQ-DataField-GPS",
  "https://github.com/ravenfeld/Connect-IQ-DataField-Speed",
  "https://github.com/ravenfeld/Connect-IQ-Widget-Compass",
  {
    root: "https://github.com/rexMingla/low-battery-mode",
    options: { checkInvalidSymbols: "WARNING" },
  },
  "https://github.com/rgergely/polesteps",
  "https://github.com/rgrellmann/connectiq-bergsteigen-app",
  "https://github.com/roelofk/HeartRateRunner",
  {
    root: "https://github.com/samuelmr/garmin-abouttime",
    include: "monkey-eng.jungle",
  },
  "https://github.com/seajay/ColourHR",
  "https://github.com/simonl-ciq/RollingAverage",
  "https://github.com/simonmacmullen/activity-widget",
  {
    root: "https://github.com/simonmacmullen/chart-datafields",
    jungleContent: [
      "base.sourcePath=./**.mc;../../src",
      "base.resourcePath=../../resources;./strings.xml",
    ],
  },
  "https://github.com/simonmacmullen/hr-widget",
  "https://github.com/simonmacmullen/instrument-panel",
  "https://github.com/sixtop/Watch-Face-Garmin",
  "https://github.com/smeyac/connect-iq",
  {
    root: "https://github.com/sparksp/Analog24",
    build: false,
    comment: "Manifest needs a launcher icon",
  },
  {
    root: "https://github.com/spikyjt/SailingTimer",
    options: { checkInvalidSymbols: "WARNING" },
  },
  "https://github.com/srwalter/garmin-tesla",
  "https://github.com/sunpazed/garmin-ciqsummit17",
  "https://github.com/sunpazed/garmin-drawaa",
  {
    root: "https://github.com/sunpazed/garmin-flags",
    exclude: "temp/monkey.jungle",
  },
  "https://github.com/sunpazed/garmin-mario",
  "https://github.com/sunpazed/garmin-mickey",
  {
    root: "https://github.com/sunpazed/garmin-nyan-cat",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  "https://github.com/sunpazed/garmin-oz",
  "https://github.com/sunpazed/garmin-polybug",
  "https://github.com/sunpazed/garmin-vangogh",
  "https://github.com/sunpazed/garmin-waketest",
  "https://github.com/thekr1s/garmin_wordclock",
  "https://github.com/tobiaslj/TrendPace",
  "https://github.com/toomasr/8-min-abs",
  "https://github.com/toskaw/ImageNotify",
  {
    root: "https://github.com/travisvitek/connectiq_laps_datafield",
    jungleContent: [
      "rectangle-200x265.excludeAnnotations=high_memory_device;rectangle_205x148;rectangle_240x400;round_218x218;round_240x240;semiround_215x180",
      "rectangle-205x148.excludeAnnotations=high_memory_device;rectangle_200x265;rectangle_240x400;round_218x218;round_240x240;semiround_215x180",
      "rectangle-240x400.excludeAnnotations=high_memory_device;rectangle_200x265;rectangle_205x148;round_218x218;round_240x240;semiround_215x180",
      "round-218x218.excludeAnnotations=high_memory_device;rectangle_200x265;rectangle_205x148;rectangle_240x400;round_240x240;semiround_215x180",
      "round-240x240.excludeAnnotations=high_memory_device;rectangle_200x265;rectangle_205x148;rectangle_240x400;round_218x218;semiround_215x180",
      "semiround-215x180.excludeAnnotations=low_memory_device;rectangle_200x265;rectangle_205x148;rectangle_240x400;round_218x218;round_240x240",
    ],
  },
  "https://github.com/urbandroid-team/Sleep-as-Android-Garmin-Addon",
  "https://github.com/victornottat/garmin-trimp-perhour",
  "https://github.com/victornottat/garmin-trimp",
  "https://github.com/vmaywood/Garmin-Watch-Faces",
  {
    root: "https://github.com/voseldop/timeless",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  {
    root: "https://github.com/vovan-/cyclist-datafiled-garmin",
    build: false,
    comment: "missing launcher icon",
  },
  {
    root: "https://github.com/vtrifonov-esfiddle/Meditate",
    exclude:
      "barrels.jungle|(HrvAlgorithms|ScreenPicker|StatusIconFonts).monkey.jungle",
  },
  "https://github.com/warmsound/crystal-face",
  "https://github.com/werkkrew/ciq-orange-theory",
  "https://github.com/zbraniecki/ultitimer",
  "https://gitlab.com/HankG/GarminConnectIQ",
  {
    root: "https://gitlab.com/harryonline/emergencyinfo",
    options: { checkInvalidSymbols: "WARNING" },
  },
  "https://gitlab.com/harryonline/fortune-quote",
  "https://gitlab.com/harryonline/timerwidget",
  "https://gitlab.com/nz_brian/HiVisRunField",
  "https://gitlab.com/nz_brian/garmin.watch.analogplus",
  {
    root: "https://gitlab.com/ravenfeld/Connect-IQ-App-Timer",
    options: { checkInvalidSymbols: "WARNING" },
  },
];

export async function fetchGitProjects(projects: RemoteProject[]) {
  const dir = path.join(__dirname, "..", "build", "test", "projects");
  await fs.mkdir(dir, { recursive: true });
  const failures: string[] = [];
  const result = await promiseAll((i: number) => {
    if (i >= projects.length) return null;
    const p = projects[i];
    const {
      root,
      include = null,
      exclude = null,
      build = null,
      options = null,
      sourcePath = null,
      jungleContent = null,
      rename = null,
    } = typeof p === "string" ? { root: p } : p;
    const name = root.replace(/(^.*\/(.*)\/)/, "$2-");
    const projDir = path.resolve(dir, name);
    return fetchAndClean(projDir, root)
      .then((output) => {
        if (!rename) {
          return output;
        }
        return Promise.all(
          rename.map((e) =>
            fs.rename(path.join(projDir, e.from), path.join(projDir, e.to))
          )
        ).then(() => output);
      })
      .then((output) => {
        console.log(output);
        return globa(`${projDir}/**/*.jungle`);
      })
      .then((jungles) => {
        if (jungles.length) return jungles;
        return globa(`${projDir}/**/manifest.xml`).then((manifests) =>
          Promise.all(
            manifests.map(async (m) => {
              const jungle = path.resolve(path.dirname(m), "monkey.jungle");
              await fs.writeFile(
                jungle,
                `project.manifest = manifest.xml\n${
                  sourcePath ? `base.sourcePath=${sourcePath}` : ""
                }\n${jungleContent ? jungleContent.join("\n") : ""}\n`
              );
              return jungle;
            })
          )
        );
      })
      .then((jungles) => {
        if (include) {
          const re = new RegExp(include);
          jungles = jungles.filter((j) => re.test(j));
        }
        if (exclude) {
          const re = new RegExp(exclude);
          jungles = jungles.filter((j) => !re.test(j.replace(/\\/g, "/")));
        }
        return options || build === false
          ? jungles.map((jungle) => ({ jungle, build, options }))
          : jungles;
      })
      .catch((e) => {
        failures.push(`${root}: ${e.toString()}`);
        return [];
      });
  }, 16);
  failures.forEach((p) => console.error("Bad project: " + p));
  return result.flat();
}

function fetchAndClean(projDir: string, root: string) {
  const gitDir = path.resolve(projDir, ".git");
  const output = [`Updating project ${root}`];
  const logger = (line: string) => output.push(` - ${line}`);
  const loggers = [logger, logger];
  return fs
    .stat(gitDir)
    .catch(() => null)
    .then((s) =>
      !s
        ? spawnByLine(
            "git",
            ["clone", root + ".git", path.basename(projDir)],
            loggers,
            {
              cwd: path.resolve(projDir, ".."),
            }
          )
        : null
    )
    .then(() =>
      spawnByLine("git", ["fetch", "origin"], loggers, {
        cwd: projDir,
      })
    )
    .then(() =>
      spawnByLine("git", ["reset", "--hard", "FETCH_HEAD"], loggers, {
        cwd: projDir,
      })
    )
    .then(() =>
      spawnByLine("git", ["clean", "-fxd"], loggers, {
        cwd: projDir,
      })
    )
    .then(() =>
      globa(
        path.join(
          __dirname,
          "..",
          "test",
          "projects",
          "patches",
          path.basename(projDir),
          "*.patch"
        )
      )
    )
    .then((patches) =>
      patches.length
        ? spawnByLine("git", ["am", ...patches], loggers, {
            cwd: projDir,
          })
        : undefined
    )
    .then(() => output.join("\n"))
    .catch(() => {
      throw new Error(output.join("\n"));
    });
}
