#!/usr/bin/env node
'use strict';
const base = require('./index');
const prompt = require('prompt');

const savePrompts = {
  desktopFilePath: (error, win, stdout) => {
    return new Promise((fulfill, reject) => {
      function askForVal(displayEntries) {
        // autosave first entry for now
        if (displayEntries && displayEntries[0]) {
          fulfill(displayEntries[0]);
        } else {
          reject();
        }
      }

      if (error) {
        if (stdout) {
          askForVal(stdout.split('\n'));
        } else {
          askForVal();
        }
      } else {
        const displayEntries = stdout.split('\n');
        let displayStr = '';
        for (let i = 0; i < displayEntries.length; i++) {
          if (displayEntries[i] !== '') {
            displayStr += `${i + 1}. ${displayEntries[i]} \n`;
          }
        }

        askForVal(displayEntries);
      }
    });
  }
};

const isCloseAllWinBefore = process.argv.indexOf('--closeAllOpenWindows') > -1;
const action = process.argv[2];
let sessionName;
if (process.argv[3] && !process.argv[3].match(/^--/)) {
  sessionName = process.argv[3];
}

if (action === 'save') {
  base.saveSession(sessionName, savePrompts);
} else if (action === 'restore') {
  base.restoreSession(sessionName, isCloseAllWinBefore);
} else if (action === 'remove') {
  base.removeSession(sessionName);
} else {
  console.log(`
  Usage:\n
  Saving your current windows:
  lwsm save [OPTIONAL_SESSION_ID] 
  
  Restoring a session:
  lwsm restore [OPTIONAL_SESSION_ID] [--closeAllOpenWindows]
  `);
}