import { spawnByLine, globa, __dirname } from "../build/util.cjs";
import path from "path";
import * as fs from "fs/promises";

export const githubProjects = [
  "https://bitbucket.org/mike_polatoglou/moonphase",
  "https://bitbucket.org/obagot/connectiq-hict",
  "https://bitbucket.org/villagehymn/marklaying",
  "https://github.com/30Wedge/SwagginNumerals",
  "https://github.com/4ch1m/HueCIQ",
  "https://github.com/DeCaPa/MyBigDate",
  "https://github.com/HanSolo/digital",
  "https://github.com/HerrRiebmann/Stretch",
  "https://github.com/HookyQR/TidyField",
  "https://github.com/HookyQR/TidyWatch",
  "https://github.com/Laverlin/Yet-Another-Sailing-App",
  "https://github.com/Laverlin/Yet-Another-WatchFace",
  "https://github.com/OliverHannover/Aviatorlike",
  "https://github.com/OliverHannover/Formula_1",
  "https://github.com/Peterdedecker/connectiq",
  "https://github.com/Tkadla-GSG/garmin",
  "https://github.com/ToryStark/connect-iq",
  "https://github.com/TrainAsONE/trainasone-connectiq",
  "https://github.com/YoungChulDK/GarminCryptoPrices",
  "https://github.com/adamml/tempo-trainer",
  "https://github.com/admsteck/ConnectIQ",
  "https://github.com/alanfischer/hassiq",
  "https://github.com/alexphredorg/ConnectIqSailingApp",
  "https://github.com/andriijas/connectiq-apps",
  "https://github.com/antirez/iqmeteo",
  "https://github.com/antonioasaro/GARMIN-AMD_Watchface",
  "https://github.com/antonioasaro/Garmin-Antonio_SMS",
  "https://github.com/aronsommer/WebRequestGlance-Widget",
  "https://github.com/aronsommer/WebRequestMultiple-Widget",
  "https://github.com/axl13/PowerAdjuster",
  "https://github.com/blaskovicz/garmin-nest-camera-control",
  "https://github.com/breber/helicopter-iq",
  "https://github.com/breber/nest-iq",
  "https://github.com/cedric-dufour/connectiq-app-glidersk",
  "https://github.com/cedric-dufour/connectiq-app-towplanesk",
  "https://github.com/chanezgr/IQwprimebal",
  "https://github.com/chris220688/garmin-myBus-app",
  {
    root: "https://github.com/clementbarthes/GarminCogDisplay",
    exclude: ["temp[\\\\\\/]monkey\\.jungle"],
  },
  "https://github.com/creacominc/connectiq-PowerField",
  "https://github.com/creacominc/connectiq-PowerFieldTests",
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
  "https://github.com/dbcm/KISSFace",
  "https://github.com/desyat/OpenWeatherMapWidget",
  "https://github.com/dkappler/kraken",
  "https://github.com/dmuino/HMFields",
  "https://github.com/douglasr/connectiq-logo-analog",
  "https://github.com/douglasr/connectiq-samples",
  "https://github.com/ebolefeysot/CIQ_PcvVo2max",
  "https://github.com/fhdeutschmann/ZuluTime",
  "https://github.com/fjbenitog/bike-simulator",
  "https://github.com/fjbenitog/digital-watch-cas10",
  "https://github.com/fmercado/telemeter",
  "https://github.com/gcormier9/GRun",
  "https://github.com/gimportexportdevs/gimporter",
  "https://github.com/grafstrom/ORun",
  "https://github.com/hakonrossebo/FootballFixtures",
  "https://github.com/hansiglaser/ConnectIQ",
  "https://github.com/haraldh/SunCalc",
  "https://github.com/imgrant/AuxHR",
  "https://github.com/imgrant/EnergyExpenditureField",
  "https://github.com/imgrant/FlexiRunner",
  "https://github.com/imgrant/RunningEconomyField",
  {
    root: "https://github.com/jensws80/JSClock",
    exclude: ".*",
    comment: "Its missing a manifest.xml",
  },
  "https://github.com/joakim-ribier/ftw-garmin",
  "https://github.com/joergsteinkamp/Simplog",
  {
    root: "https://github.com/johnnyw3/connectiq-watchapps",
    exclude: "Data Fields.TurnAroundReminder.monkey.jungle",
    comment: "Has syntax errors",
  },
  "https://github.com/jonasbcdk/CleanSteps",
  "https://github.com/kolyuchii/TravelCalc",
  "https://github.com/kopa/BikersField",
  "https://github.com/kopa/RunnersField",
  "https://github.com/kromar/garmin_fenix3",
  "https://github.com/landnavapp/LandNavApp",
  "https://github.com/lcj2/ciq_binarywatch",
  "https://github.com/lcj2/ciq_monkeyfuel",
  "https://github.com/lucamrod/TriathlonDuathlonAquathlon",
  "https://github.com/lukasz-duda/NormalizedPoolDistance",
  "https://github.com/matco/badminton",
  "https://github.com/matmuc/SportMonitor",
  "https://github.com/matthiasmullie/connect-iq-datafield-accurate-pace",
  "https://github.com/matthiasmullie/connect-iq-datafield-calories-equivalent",
  "https://github.com/mettyw/activity_view",
  "https://github.com/miss-architect/garmin-squash",
  "https://github.com/mrfoto/ForecastLine",
  "https://github.com/myneur/HeartRateRunner",
  "https://github.com/myneur/late",
  "https://github.com/okdar/smartarcs",
  "https://github.com/pedlarstudios/WordOfTheDay",
  "https://github.com/psjo/arcsin",
  "https://github.com/psjo/darktimes",
  "https://github.com/psjo/dotter",
  "https://github.com/psjo/felt",
  "https://github.com/rain-dl/DayRound",
  "https://github.com/ravenfeld/Connect-IQ-DataField-BackToHome",
  "https://github.com/ravenfeld/Connect-IQ-DataField-GPS",
  "https://github.com/ravenfeld/Connect-IQ-DataField-Speed",
  "https://github.com/ravenfeld/Connect-IQ-Widget-Compass",
  "https://github.com/rexMingla/low-battery-mode",
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
  "https://github.com/simonmacmullen/chart-datafields",
  "https://github.com/simonmacmullen/hr-widget",
  "https://github.com/simonmacmullen/instrument-panel",
  "https://github.com/sixtop/Watch-Face-Garmin",
  "https://github.com/smeyac/connect-iq",
  {
    root: "https://github.com/sparksp/Analog24",
    build: false,
    comment: "Manifest needs a launcher icon",
  },
  "https://github.com/spikyjt/SailingTimer",
  "https://github.com/srwalter/garmin-tesla",
  "https://github.com/sunpazed/garmin-ciqsummit17",
  "https://github.com/sunpazed/garmin-drawaa",
  {
    root: "https://github.com/sunpazed/garmin-flags",
    exclude: "temp/monkey.jungle",
  },
  "https://github.com/sunpazed/garmin-mario",
  "https://github.com/sunpazed/garmin-mickey",
  "https://github.com/sunpazed/garmin-nyan-cat",
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
  "https://github.com/voseldop/timeless",
  "https://github.com/vovan-/cyclist-datafiled-garmin",
  {
    root: "https://github.com/vtrifonov-esfiddle/Meditate",
    exclude: "barrels.jungle",
  },
  "https://github.com/warmsound/crystal-face",
  "https://github.com/werkkrew/ciq-orange-theory",
  "https://github.com/zbraniecki/ultitimer",
  {
    root: "https://gitlab.com/HankG/GarminConnectIQ",
    build: false,
    comment: "Double declaration of a variable",
  },
  "https://gitlab.com/harryonline/emergencyinfo",
  "https://gitlab.com/harryonline/fortune-quote",
  "https://gitlab.com/harryonline/fortune-quote",
  "https://gitlab.com/harryonline/timerwidget",
  "https://gitlab.com/nz_brian/HiVisRunField",
  "https://gitlab.com/nz_brian/garmin.watch.analogplus",
  "https://gitlab.com/ravenfeld/Connect-IQ-App-Timer",
];

export async function fetchGitProjects(projects) {
  const dir = path.join(__dirname, "..", "build", "test", "projects");
  await fs.mkdir(dir, { recursive: true });
  const result = [];
  const failures = [];
  let promise = Promise.resolve();
  projects.forEach((p) => {
    const { root, include, exclude, build } = p.root ? p : { root: p };
    const name = root.replace(/(^.*\/(.*)\/)/, "$2-");
    const projDir = path.resolve(dir, name);
    promise = promise
      .then(() => fetchAndClean(projDir, root))
      .then(() => globa(`${projDir}/**/*.jungle`))
      .then((jungles) => {
        if (jungles.length) return jungles;
        return globa(`${projDir}/**/manifest.xml`).then((manifests) =>
          Promise.all(
            manifests.map(async (m) => {
              const jungle = path.resolve(path.dirname(m), "monkey.jungle");
              await fs.writeFile(jungle, "project.manifest = manifest.xml\n");
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
          jungles = jungles.filter((j) => !re.test(j));
        }
        if (build === false) {
          jungles = jungles.map((jungle) => {
            return { jungle, build };
          });
        }
        result.push(...jungles);
      })
      .catch(() => failures.push(root));
  });
  return promise.then(() => {
    failures.forEach((p) => console.error("Bad project: " + p));
    return result;
  });
}

function fetchAndClean(projDir, root) {
  const gitDir = path.resolve(projDir, ".git");
  return fs
    .stat(gitDir)
    .catch(() => null)
    .then((s) =>
      !s
        ? spawnByLine(
            "git",
            ["clone", root + ".git", path.basename(projDir)],
            (line) => console.log(line),
            {
              cwd: path.resolve(projDir, ".."),
            }
          )
        : null
    )
    .then(() =>
      spawnByLine("git", ["fetch", "origin"], (line) => console.log(line), {
        cwd: projDir,
      })
    )
    .then(() =>
      spawnByLine(
        "git",
        ["rebase", "FETCH_HEAD"],
        (line) => console.log(line),
        {
          cwd: projDir,
        }
      )
    )
    .then(() =>
      spawnByLine(
        "git",
        ["reset", "--hard", "HEAD"],
        (line) => console.log(line),
        {
          cwd: projDir,
        }
      )
    )
    .then(() =>
      spawnByLine("git", ["clean", "-fxd"], (line) => console.log(line), {
        cwd: projDir,
      })
    );
}
