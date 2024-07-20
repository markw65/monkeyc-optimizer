let loggerSettings: Map<string, number> | null = null;
let loggerLevelOffset = 0;
let theLogger = console.log;

export function logger(module: string, level: number, message: unknown) {
  if (wouldLog(module, level)) {
    log(typeof message === "function" ? message() : message);
  }
}

export function wouldLog(module: string, level: number) {
  if (!loggerSettings) {
    loggerSettings = getLoggerSettings();
  }
  return (
    (loggerSettings.get(module) ?? loggerSettings.get("*") ?? 0) >=
    level + loggerLevelOffset
  );
}

export function bumpLogging(module: string | null, amount: number) {
  if (!module) {
    loggerLevelOffset += amount;
  } else {
    if (!loggerSettings) {
      loggerSettings = getLoggerSettings();
    }
    const level = loggerSettings.get(module);
    if (level != null) {
      loggerSettings.set(module, level - amount);
    }
  }
}

let banner: (() => void) | null = null;
export function setBanner(b: (() => string) | null) {
  banner = b;
}

export let logPromise: Promise<unknown> = Promise.resolve();
let livePromises = 0;

export function log(...messages: unknown[]) {
  if (banner) {
    const b = banner;
    banner = null;
    theLogger(b());
  }
  messages.forEach((message) => {
    if (livePromises || (message as { then?: unknown }).then) {
      livePromises++;
      logPromise = logPromise
        .then(() => Promise.resolve(message))
        .then((m) => {
          livePromises--;
          if (theLogger === console.log) {
            theLogger(m);
          } else {
            theLogger(`${m}`);
          }
        });
    } else {
      if (theLogger === console.log) {
        theLogger(message);
      } else {
        theLogger(`${message}`);
      }
    }
  });
  return logPromise;
}

export function setLogger(log: (message: string) => void) {
  theLogger = log;
}

function getLoggerSettings() {
  const ls = new Map();
  const settings = process.env["MC_LOGGER"];
  if (settings) {
    settings.split(";").forEach((setting) => {
      const results = setting.split(/[:=]/, 2);
      if (results.length === 1) {
        ls.set(results[0], 1);
      } else {
        ls.set(results[0], Number(results[1]));
      }
    });
  }
  return ls;
}
