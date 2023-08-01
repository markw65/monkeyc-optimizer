import * as fs from "fs/promises";
import * as path from "path";
import { globa, promiseAll, spawnByLine } from "./util";
import { BuildConfig } from "./optimizer-types";

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
      garminOptLevel?: number;
      test?: boolean | string[];
      branch?: string;
    };

export const githubProjects: RemoteProject[] = [
  "https://bitbucket.org/mike_polatoglou/moonphase",
  "https://bitbucket.org/obagot/connectiq-hict",
  "https://bitbucket.org/villagehymn/marklaying",
  { root: "https://github.com/30Wedge/SwagginNumerals", test: true },
  { root: "https://github.com/4ch1m/HueCIQ", test: true },
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
    test: true,
  },
  {
    root: "https://github.com/Laverlin/Yet-Another-WatchFace",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  "https://github.com/OliverHannover/Aviatorlike",
  "https://github.com/OliverHannover/Formula_1",
  {
    root: "https://github.com/Peterdedecker/connectiq",
    test: true,
  },
  { root: "https://github.com/Tkadla-GSG/garmin", test: true },
  "https://github.com/ToryStark/connect-iq",
  {
    root: "https://github.com/TrainAsONE/trainasone-connectiq",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  "https://github.com/YoungChulDK/GarminCryptoPrices",
  "https://github.com/adamml/tempo-trainer",
  "https://github.com/admsteck/ConnectIQ",
  {
    root: "https://github.com/alanfischer/hassiq",
    options: {
      checkInvalidSymbols: "WARNING",
      compilerOptions: "--Eno-invalid-symbol",
    },
    test: true,
  },
  {
    root: "https://github.com/alexphredorg/ConnectIqSailingApp",
    options: { checkInvalidSymbols: "WARNING" },
  },
  "https://github.com/andriijas/connectiq-apps",
  "https://github.com/antirez/iqmeteo",
  "https://github.com/Antvirf/spectrefenix",
  "https://github.com/Antvirf/garmin-watch-face-guide",
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
  "https://github.com/bombsimon/garmin-seaside",
  {
    root: "https://github.com/breber/helicopter-iq",
    build: false,
    comment: "missing launcher icon",
  },
  "https://github.com/breber/nest-iq",
  {
    root: "https://github.com/flocsy/BodyBatteryDF",
    options: { typeCheckLevel: "Strict" },
  },
  "https://github.com/markw65/connectiq-app-glidersk",
  "https://github.com/markw65/connectiq-app-towplanesk",
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
    test: false,
    comment: "tests crash the simulator",
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
  {
    root: "https://github.com/desyat/OpenWeatherMapWidget",
    options: { checkInvalidSymbols: "WARNING" },
  },
  {
    root: "https://github.com/dkappler/kraken",
    options: { compilerOptions: "--Eno-invalid-symbol" },
    build: false,
    comment: "Missing classes",
  },
  "https://github.com/dmuino/HMFields",
  "https://github.com/douglasr/connectiq-logo-analog",
  "https://github.com/douglasr/connectiq-samples",
  "https://github.com/ebolefeysot/CIQ_PcvVo2max",
  "https://github.com/fhdeutschmann/ZuluTime",
  {
    root: "https://github.com/fjbenitog/bike-simulator",
    options: { checkInvalidSymbols: "WARNING" },
    test: true,
  },
  "https://github.com/fjbenitog/digital-watch-cas10",
  "https://github.com/fmercado/telemeter",
  {
    root: "https://github.com/garmin/connectiq-apps",
    exclude: "/barrels/|barrels.jungle",
    options: { compilerOptions: "--Eno-invalid-symbol" },
    test: false,
    comment: "tests fail/crash simulator",
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
  { root: "https://github.com/haraldh/SunCalc", test: true },
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
  { root: "https://github.com/lukasz-duda/NormalizedPoolDistance", test: true },
  {
    root: "https://github.com/matco/badminton",
    test: ["fenix5", "fenix6", "fenix7"],
  },
  {
    root: "https://github.com/matmuc/SportMonitor",
    options: { compilerOptions: "--Eno-invalid-symbol" },
  },
  "https://github.com/matthiasmullie/connect-iq-datafield-accurate-pace",
  "https://github.com/matthiasmullie/connect-iq-datafield-calories-equivalent",
  "https://github.com/mettyw/activity_view",
  "https://github.com/miss-architect/garmin-squash",
  {
    root: "https://github.com/mossprescott/moonface",
    options: { checkCompilerLookupRules: "OFF" },
    branch: "font-rendering",
    test: false,
  },
  {
    root: "https://github.com/mrfoto/ForecastLine",
    options: {
      checkInvalidSymbols: "WARNING",
      compilerOptions: "--Eno-invalid-symbol",
    },
    comment: "Missing a 'secrets' file",
  },
  "https://github.com/myneur/HeartRateRunner",
  {
    root: "https://github.com/myneur/late",
    options: { compilerOptions: "--Eno-invalid-symbol" },
    include: "test.jungle",
    test: true,
  },
  { root: "https://github.com/okdar/smartarcs", test: true },
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
    test: true,
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
  {
    root: "https://github.com/srwalter/garmin-tesla",
    options: { checkInvalidSymbols: "WARNING" },
  },
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
  "https://github.com/travisvitek/connectiq_laps_datafield",
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
    options: {
      checkInvalidSymbols: "WARNING",
      checkCompilerLookupRules: "WARNING",
    },
    test: true,
  },
  {
    root: "https://github.com/warmsound/crystal-face",
    options: { compilerOptions: "--Eno-invalid-symbol" },
    test: true,
  },
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

export async function fetchGitProjects(
  projects: RemoteProject[],
  testOnly: boolean,
  skipRemote: boolean
) {
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
      garminOptLevel = null,
      test = false,
      branch = null,
    } = typeof p === "string" ? { root: p } : p;
    if (testOnly && !test) return Promise.resolve([]);
    const name = root.replace(/(^.*\/(.*)\/)/, "$2-");
    const projDir = path.resolve(dir, name);
    return fetchAndClean(projDir, root, skipRemote, branch)
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
              if (!jungles.includes(jungle)) {
                await fs.writeFile(
                  jungle,
                  `project.manifest = manifest.xml\n${
                    sourcePath ? `base.sourcePath=${sourcePath}` : ""
                  }\n${jungleContent ? jungleContent.join("\n") : ""}\n`
                );
              }
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
        return options ||
          build === false ||
          garminOptLevel !== null ||
          Array.isArray(test)
          ? jungles.map((jungle) => ({
              jungle,
              build,
              options,
              garminOptLevel,
              products: Array.isArray(test) ? test : null,
            }))
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

function fetchAndClean(
  projDir: string,
  root: string,
  skipRemote: boolean,
  branch: string | null
) {
  const gitDir = path.resolve(projDir, ".git");
  const output = [`Updating project ${root}`];
  const logger = (line: string) => output.push(` - ${line}`);
  const loggers = [logger, logger];
  const fetch = () =>
    spawnByLine("git", ["fetch", "origin"].concat(branch ?? []), loggers, {
      cwd: projDir,
    }).then(() =>
      spawnByLine(
        "git",
        ["diff", "FETCH_HEAD", `origin/${branch ?? "HEAD"}`],
        loggers,
        {
          cwd: projDir,
        }
      )
    );
  return fs
    .stat(gitDir)
    .catch(() => null)
    .then((s) => {
      if (s) return null;
      if (skipRemote) {
        throw new Error(
          `skipRemote was set, but ${root}.git had not been cloned`
        );
      }
      return spawnByLine(
        "git",
        ["clone", root + ".git", path.basename(projDir)],
        loggers,
        {
          cwd: path.resolve(projDir, ".."),
        }
      );
    })
    .then(() => (skipRemote ? undefined : fetch().catch(fetch)))
    .then(() =>
      spawnByLine("git", ["reset", "--hard", "origin/HEAD"], loggers, {
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
