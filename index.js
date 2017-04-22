'use strict';

const exec = require('child_process').exec;
const spawn = require('child_process').spawn;
const Store = require('jfs');
const fs = require('fs');
const waterfall = require('promise-waterfall');
const DESKTOP_ENV = process.env.DESKTOP_SESSION;

let db;
let CFG;

// init first
init();

module.exports = {
  saveSession,
  removeSession,
  restoreSession,
  getConnectedDisplaysId,
  resetCfg: () => {
  },
  getCfg: () => {
    return CFG;
  },
  getDb: () => {
    return db;
  }
};

function init() {
  const mkdirSync = (dirPath) => {
    try {
      fs.mkdirSync(dirPath);
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
    }
  };

  const copySync = (src, dest) => {
    if (!fs.existsSync(src)) {
      return false;
    }
    const data = fs.readFileSync(src, 'utf-8');
    fs.writeFileSync(dest, data);
  };

  const dataDir = getUserHome() + '/.lwsm';
  const sessionDataDir = dataDir + '/sessionData';

  try {
    // if config is already in place
    CFG = JSON.parse(fs.readFileSync(dataDir + '/config.json', 'utf8'));
  } catch (e) {
    // if there is no config yet load default cfg and create files and dirs
    CFG = JSON.parse(fs.readFileSync(__dirname + '/config.json', 'utf8'));
    mkdirSync(dataDir);
    mkdirSync(sessionDataDir);

    // copy files
    copySync(__dirname + '/config.json', dataDir + '/config.json');
  }

  // create data store
  db = new Store(sessionDataDir);

  // also make data dirs accessible to the outside
  CFG.DATA_DIR = dataDir;
  CFG.SESSION_DATA_DIR = sessionDataDir;
}

function getUserHome() {
  return process.env[(process.platform === 'win32') ? 'USERPROFILE' : 'HOME'];
}

function catchGenericErr(err) {
  console.error('Generic Error', err);
}

function saveSession(sessionName, inputHandlers) {
  const sessionToHandle = sessionName || 'DEFAULT';

  return getActiveWindowList()
    .then((windowList) => {
      return Promise.all([
        readAndSetAdditionalMetaData(windowList)
          .catch((err) => {
            console.error('An error occurred during readAndSetAdditionalMetaData', err);
          }),
        guessAndSetDesktopFilePaths(windowList, inputHandlers.desktopFilePath)
          .catch((err) => {
            console.error('An error occurred during guessAndSetDesktopFilePaths', err);
          }),
        getConnectedDisplaysId()
          .catch((err) => {
            console.error('An error occurred during getConnectedDisplaysId', err);
          }),
      ]);
    })
    .then((results) => {
      const windowList = results[0];
      const connectedDisplaysId = results[2];
      return saveSessionForDisplayToDb(sessionToHandle, connectedDisplaysId, windowList)
        .catch((err) => {
          console.error('An error occurred during saveSessionForDisplayToDb', err);
        });
    })
    .catch((err) => {
      console.error('An error occurred', err);
    });
}

function saveSessionForDisplayToDb(sessionToHandle, connectedDisplaysId, windowList) {
  return new Promise((fulfill, reject) => {
    // check if entry exists and update
    db.get(sessionToHandle, (err, sessionData) => {
      if (!sessionData) {
        // create new object
        sessionData = {
          name: sessionToHandle,
        };
      }
      if (!sessionData.displaysCombinations || !Array.isArray(sessionData.displaysCombinations)) {
        // create new array
        sessionData.displaysCombinations = [];
      }

      const existingDisplayEntry = sessionData.displaysCombinations.find((entry) => entry.id === connectedDisplaysId);
      if (existingDisplayEntry) {
        existingDisplayEntry.windowList = windowList;
      } else {
        sessionData.displaysCombinations.push({
          id: connectedDisplaysId,
          windowList,
        });
      }

      db.save(sessionToHandle, sessionData, (err) => {
        if (err) {
          reject(err);
        } else {
          console.log('SAVED SESSION: ' + sessionToHandle);
          fulfill();
        }
      });
    });
  });
}

function restoreSession(sessionName, isCloseAllOpenWindows) {
  const sessionToHandle = sessionName || 'DEFAULT';

  return new Promise((fulfill, reject) => {
    db.get(sessionToHandle || 'DEFAULT', (err, sessionData) => {
      if (err) {
        reject(err);
        return;
      }

      let savedWindowList;

      closeAllWindowsIfSet(isCloseAllOpenWindows)
        .then(goToFirstWorkspace)
        .then(getConnectedDisplaysId)
        .then((connectedDisplaysId) => {
          if (!sessionData.displaysCombinations) {
            console.error(`no display combinations saved yet`);
            return;
          }

          const displayEntry = sessionData.displaysCombinations.find((entry) => entry.id === connectedDisplaysId);

          if (displayEntry) {
            savedWindowList = displayEntry.windowList;
          } else {
            console.error(`no data for current display id '${connectedDisplaysId}' saved yet`);
            return;
          }
          return getActiveWindowList();
        })
        .then((currentWindowList) => {
          return startSessionPrograms(savedWindowList, currentWindowList);
        })
        .then(() => {
          // gets current window list by itself and returns the updated variant
          return waitForAllAppsToStart(savedWindowList)
        })
        .then((updatedCurrentWindowList) => {
          updateWindowIds(savedWindowList, updatedCurrentWindowList);
          return restoreWindowPositions(savedWindowList);
        })
        .then(() => {
          console.log('RESTORED SESSION: ' + sessionToHandle);
        })
        .catch((err) => {
          console.error('An error occurred', err);
          reject(err);
        })
        .then(fulfill);
    });
  });
}

function removeSession(sessionName) {
  return new Promise((fulfill, reject) => {
    fs.unlink(CFG.SESSION_DATA_DIR + '/' + sessionName + '.json', (error) => {
      if (error) {
        console.error(error);
        reject(error);
      } else {
        fulfill();
      }
    });
  });
}

function closeAllWindowsIfSet(isCloseAll) {
  return new Promise((fulfill, reject) => {
    if (isCloseAll) {
      getActiveWindowList()
        .then((currentWindowList) => {
          currentWindowList.forEach((win) => {
            closeWindow(win.windowId);
          });

          waitForAllAppsToClose()
            .then(fulfill)
            .catch(reject);
        });
    } else {
      fulfill();
    }
  }).catch(catchGenericErr);
}

function closeWindow(windowId) {
  const cmd = 'wmctrl -ic ' + windowId;
  return new Promise((fulfill, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error || stderr) {
        console.error(error, stderr);
        reject(error || stderr);
      } else {
        fulfill();
      }
    });
  }).catch(catchGenericErr);
}

function goToFirstWorkspace() {
  const cmd = 'xdotool set_desktop_viewport 0 0';
  return new Promise((fulfill, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error || stderr) {
        console.error(error, stderr);
        reject(error || stderr);
      } else {
        fulfill();
      }
    });
  });
}

function getConnectedDisplaysId() {
  const cmd = `xrandr --query | grep '\\bconnected\\b'`;
  return new Promise((fulfill, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error || stderr) {
        console.error(error, stderr);
        reject(error || stderr);
      } else {
        const connectedDisplaysId = parseConnectedDisplaysId(stdout);
        fulfill(connectedDisplaysId);
      }
    });
  });
}

function parseConnectedDisplaysId(stdout) {
  let idString = '';
  const RESOLUTION_REG_EX = /[0-9]{3,5}x[0-9]{3,5}/;
  const lines = stdout.split('\n');
  lines.forEach((line) => {
    if (line !== '') {
      const resolution = RESOLUTION_REG_EX.exec(line);
      // only do this if we have a resolution as that means that the display is active
      if (resolution) {
        idString += resolution + ';';
      }
    }
  });

  if (idString.length) {
    // cut off last semicolon
    return idString.substring(0, idString.length - 1);
  }
}

function waitForAllAppsToClose() {
  let totalTimeWaited = 0;
  return new Promise((fulfill, reject) => {
    function pollAllAppsClosed() {
      setTimeout(() => {
        getActiveWindowList()
          .then((currentWindowList) => {
            totalTimeWaited += CFG.POLL_ALL_APPS_STARTED_TIMEOUT;
            console.log(currentWindowList.length);
            if (currentWindowList.length !== 0) {
              if (totalTimeWaited > CFG.POLL_ALL_MAX_TIMEOUT) {
                console.error('POLL_ALL_MAX_TIMEOUT reached');
                reject('POLL_ALL_MAX_TIMEOUT reached');
              } else {
                // call recursively
                pollAllAppsClosed();
              }
            } else {
              fulfill(currentWindowList);
            }
          });
      }, CFG.POLL_ALL_APPS_STARTED_TIMEOUT);
    }

    // start once initially
    pollAllAppsClosed();
  });
}

function waitForAllAppsToStart(savedWindowList) {
  let totalTimeWaited = 0;
  return new Promise((fulfill, reject) => {
    function pollAllAppsStarted(savedWindowList) {
      setTimeout(() => {
        getActiveWindowList().then((currentWindowList) => {
          totalTimeWaited += CFG.POLL_ALL_APPS_STARTED_TIMEOUT;
          if (!isAllAppsStarted(savedWindowList, currentWindowList)) {
            if (totalTimeWaited > CFG.POLL_ALL_MAX_TIMEOUT) {
              console.error('POLL_ALL_MAX_TIMEOUT reached');
              reject('POLL_ALL_MAX_TIMEOUT reached');
            } else {
              // call recursively
              pollAllAppsStarted(savedWindowList);
            }
          } else {
            fulfill(currentWindowList);
          }
        });
      }, CFG.POLL_ALL_APPS_STARTED_TIMEOUT);
    }

    // start once initially
    pollAllAppsStarted(savedWindowList);
  });
}

function isAllAppsStarted(savedWindowList, currentWindowList) {
  let isAllStarted = true;
  savedWindowList.forEach((win) => {
    if (!getMatchingWindowId(win, currentWindowList)) {
      isAllStarted = false;
    }
  });
  return isAllStarted;
}

function readAndSetAdditionalMetaData(windowList) {
  return new Promise((fulfill, reject) => {
    const promises = [];
    windowList.forEach((win) => {
      promises.push(readAndSetAdditionalMetaDataForWin(win));
    });

    Promise.all(promises)
      .then(() => {
        fulfill(windowList);
      })
      .catch(reject);
  });
}

function readAndSetAdditionalMetaDataForWin(win) {
  return new Promise((fulfill, reject) => {
    exec(`xprop -id ${win.windowId}`, (error, stdout, stderr) => {
      if (error || stderr) {
        console.error(error, stderr);
        reject(error || stderr);
      } else {
        const lines = stdout.split('\n');

        lines.forEach((line) => {
          const words = line.split(' ');
          const propertyName = words[0];

          // remove property name and "="
          words.splice(0, 2);
          const value = words.join(' ');
          const propertyNameFromMap = CFG.WM_META_MAP[propertyName];
          if (propertyNameFromMap) {
            // special handle number types
            if (CFG.WM_META_MAP_NUMBER_TYPES.indexOf(propertyName) > -1) {
              win[propertyNameFromMap] = parseInt(value, 10);
            } else {
              win[propertyNameFromMap] = value;
            }
          }
          // parse states
          else if (propertyName === '_NET_WM_STATE(ATOM)') {
            const states = value.split(', ');
            win.states = [];
            states.forEach((state) => {
              if (state !== '' && CFG.WM_STATES_MAP[state]) {
                win.states.push(CFG.WM_STATES_MAP[state]);
              }
            });
          }
        });
        fulfill(win);
      }
    });
  });
}

function guessAndSetDesktopFilePaths(windowList, inputHandler) {
  const promises = [];
  windowList.forEach((win) => {
    promises.push(() => {
      return guessFilePath(win, inputHandler);
    });
  });

  return new Promise((fulfill, reject) => {
    waterfall(promises)
      .then(() => {
        fulfill(windowList);
      })
      .catch(reject);
  });
}

function guessFilePath(win, inputHandler) {
  return new Promise((fulfill, reject) => {
    function callInputHandler(error, stdout) {
      inputHandler(error, win, stdout)
        .then((input) => {
          if (isDesktopFile(win.executableFile)) {
            win.desktopFilePath = input;
            fulfill(win.desktopFilePath);
          } else {
            win.executableFile = input;
            fulfill(win.executableFile);
          }
        })
        .catch(reject);
    }

    if (isDesktopFile(win.executableFile)) {
      exec('locate ' + win.executableFile, (error, stdout, stderr) => {
        callInputHandler((error || stderr), stdout);
      });
    } else {
      callInputHandler(true, win.executableFile);
    }
  });
}

// TODO check for how many instances there should be running of a program
function startSessionPrograms(windowList, currentWindowList) {
  const promises = [];

  windowList.forEach((win) => {
    const numberOfInstancesOfWin = getNumberOfInstancesToRun(win, windowList);
    if (!isProgramAlreadyRunning(win.wmClassName, currentWindowList, numberOfInstancesOfWin, win.instancesStarted)) {
      promises.push(startProgram(win.executableFile, win.desktopFilePath));
      win.instancesStarted += 1;
    }
  });

  return new Promise((fulfill, reject) => {
    Promise.all(promises)
      .then((results) => {
        fulfill(results);
      })
      .catch(reject);
  });
}

function getNumberOfInstancesToRun(windowToMatch, windowList) {
  return windowList.filter((win) => {
    return win.wmClassName === windowToMatch.wmClassName;
  }).length;
}

function isProgramAlreadyRunning(wmClassName, currentWindowList, numberOfInstancesToRun = 1, instancesStarted = 0) {
  let instancesRunning = 0;
  currentWindowList.forEach((win) => {
    if (win.wmClassName === wmClassName) {
      instancesRunning++;
    }
  });
  console.log(wmClassName + ' is running: ', instancesRunning + instancesStarted >= numberOfInstancesToRun, numberOfInstancesToRun, instancesStarted);
  return instancesRunning + instancesStarted >= numberOfInstancesToRun;
}

function getActiveWindowList() {
  const cmd = 'wmctrl -p -G -l -x';

  return new Promise((fulfill, reject) => {
    exec(cmd, function (error, stdout, stderr) {
      const windowList = transformWmctrlList(stdout);
      if (error || stderr) {
        console.error(error, stderr);
        reject(error | stderr);
      } else {
        fulfill(windowList);
      }
    });
  });
}

function isDesktopFile(executableFile) {
  return executableFile && executableFile.match(/desktop$/);
}

function isExcludedWmClassName(wmClassName) {
  return CFG.WM_CLASS_EXCLUSIONS.indexOf(wmClassName) > -1;
}

function startProgram(executableFile, desktopFilePath) {
  let cmd;
  let args = [];
  if (desktopFilePath) {
    cmd = `awk`;
    args.push('/^Exec=/ {sub("^Exec=", ""); gsub(" ?%[cDdFfikmNnUuv]", ""); exit system($0)}');
    args.push(desktopFilePath);
  } else {
    cmd = executableFile;
    // TODO split args if necessary
  }

  return new Promise((fulfill) => {
    spawn(cmd, args, {
      stdio: 'ignore',
      detached: true,
    }).unref();

    // currently we have no error handling as the process is started detached
    fulfill();
  });
}

function transformWmctrlList(stdout) {
  const LINE_REG_EX = /([^\s]+)\s+(-*\d+)\s+(-*\d+)\s+(-*\d+)\s+(-*\d+)\s+(-*\d+)\s+(-*\d+)\s+([^\s]+)/;
  const data = [];
  const lines = stdout.split('\n');
  lines.forEach((line) => {
    const fields = LINE_REG_EX.exec(line);
    if (fields && !isExcludedWmClassName(fields[8])) {
      data.push({
        windowId: fields[1],
        windowIdDec: parseInt(fields[1], 16),
        gravity: parseInt(fields[2], 10),
        x: parseInt(fields[4], 10),
        y: parseInt(fields[5], 10),
        width: parseInt(fields[6], 10),
        height: parseInt(fields[7], 10),
        wmClassName: fields[8],
        simpleName: parseSimpleWindowName(fields[8]),
        executableFile: parseExecutableFileFromWmClassName(fields[8]),
      });
    }
  });
  return data;
}

function parseExecutableFileFromWmClassName(wmClassName) {
  const executableFile = CFG.WM_CLASS_AND_EXECUTABLE_FILE_MAP[wmClassName];
  if (executableFile) {
    return executableFile;
  } else {
    const splitValues = wmClassName.split('.');
    return splitValues[0] + '.desktop';
  }
}

function parseSimpleWindowName(wmClassName) {
  const splitValues = wmClassName.split('.');
  if (splitValues[1]) {
    return splitValues[1];
  } else {
    return wmClassName;
  }
}

function updateWindowIds(savedWindowList, currentWindowList) {
  const wmClassNameMap = {};
  savedWindowList.forEach((win) => {
    if (!wmClassNameMap[win.wmClassName]) {
      wmClassNameMap[win.wmClassName] = getMatchingWindows(win, currentWindowList);
    }
    win.windowId = wmClassNameMap[win.wmClassName][0].windowId;
    win.windowIdDec = parseInt(win.windowId, 16);
    wmClassNameMap[win.wmClassName].shift();
  });
}

function getMatchingWindowId(win, currentWindowList) {
  const currentWindow = currentWindowList.find((winFromCurrent) => win.wmClassName === winFromCurrent.wmClassName);
  return currentWindow && currentWindow.windowId;
}

function getMatchingWindows(win, currentWindowList) {
  return currentWindowList.filter((winFromCurrent) => win.wmClassName === winFromCurrent.wmClassName);
}

function restoreWindowPositions(savedWindowList) {
  const promises = [];
  savedWindowList.forEach((win) => {
    if (win.windowId) {
      promises.push(restoreWindowPosition(win));
    }
  });

  return new Promise((fulfill, reject) => {
    Promise.all(promises)
      .then((results) => {
        fulfill(results);
      })
      .catch(reject);
  });
}

function restoreWindowPosition(win) {
  const newPositionStr = `${win.gravity},${win.x},${win.y},${win.width},${win.height}`;
  const removeStatesStr = 'remove,maximized_vert,maximized_horz,fullscreen,above,below,hidden,sticky,modal,shaded,demands_attention';
  const baseCmd = `wmctrl -i -r ${win.windowId}`;

  // add remove states command
  let cmd = `${baseCmd} -b  ${removeStatesStr}`;

  // add restore positions command
  if (CFG.IS_USE_XDOTOOL) {
    const decId = win.windowIdDec;
    // this is what the implementation with xdotool would look like
    cmd = `${cmd} && xdotool windowsize ${decId} ${win.width} ${win.height} windowmove ${decId} ${win.x} ${win.y}`
  } else {
    cmd = `${cmd} && ${baseCmd} -e ${newPositionStr}`;
  }

  // add add states command
  if (win.states && win.states.length > 0) {
    cmd = `${cmd} &&  ${baseCmd} -b add,${win.states.join(',')}`;
  }

  return new Promise((fulfill, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error || stderr) {
        console.error(error, stderr);
        reject(error || stderr);
      } else {
        const lines = stdout.split('\n');
        win.desktopFilePath = lines[0];
        fulfill(stdout);
      }
    });
  });
}


