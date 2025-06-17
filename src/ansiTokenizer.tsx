/*
  Copyright (c) Microsoft Corporation.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

export type ANSIStyle = {
  bold?: boolean,
  dim?: boolean,
  italic?: boolean,
  underline?: boolean,
  strikethrough?: boolean,
  hidden?: boolean,
  fgColor?: string,
  bgColor?: string,
  inverseColors?: boolean,
};

export type ANSIToken = {
  text: string,
  style: ANSIStyle,
};

const regex = /(\x1b\[(\d+(;\d+)*)m)|([^\x1b]+)/g;

export class ANSITokenizer {
  private _style: ANSIStyle = {};
  private _processedTextLength = 0;

  processedTextLength() {
    return this._processedTextLength;
  }

  addText(text: string): ANSIToken[] {
    if (!text)
      return [];
    this._processedTextLength += text.length;
    const result: ANSIToken[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      const [, ,codeStr, , text] = match;
      if (codeStr) {
        const tokens = codeStr.split(';');
        for (const token of tokens) {
          const code = +token;
          switch (code) {
            case 0:
              this._style = {};
              break;
            case 1: this._style.bold = true; break;
            case 2: this._style.dim = true; break;
            case 3: this._style.italic = true; break;
            case 4: this._style.underline = true; break;
            case 7:
              this._style.inverseColors = true;
              break;
            case 8: this._style.hidden = true; break;
            case 9: this._style.strikethrough = true; break;
            case 22:
              this._style.dim = false;
              this._style.bold = false;
              break;
            case 23:
              this._style.italic = false;
              break;
            case 24:
              this._style.underline = false;
              break;
            case 27:
              this._style.inverseColors = false;
              break;
            case 30: this._style.fgColor = 'black'; break;
            case 31: this._style.fgColor = 'red'; break; 
            case 32: this._style.fgColor = 'green'; break;
            case 33: this._style.fgColor = 'yellow'; break;
            case 34: this._style.fgColor = 'blue'; break;
            case 35: this._style.fgColor = 'magenta'; break;
            case 36: this._style.fgColor = 'cyan'; break;
            case 37: this._style.fgColor = 'white'; break;
            case 39:
              delete this._style.fgColor;
              break;
            case 40: this._style.bgColor = 'black'; break;
            case 41: this._style.bgColor = 'red'; break;
            case 42: this._style.bgColor = 'green'; break;
            case 43: this._style.bgColor = 'yellow'; break;
            case 44: this._style.bgColor = 'blue'; break;
            case 45: this._style.bgColor = 'magenta'; break;
            case 46: this._style.bgColor = 'cyan'; break;
            case 47: this._style.bgColor = 'white'; break;
            case 49:
              delete this._style.bgColor;
              break;
            case 53:
              // overline; not supported.
              break;
            case 90: this._style.fgColor = 'gray'; break;
            case 91: this._style.fgColor = 'redBright'; break;
            case 92: this._style.fgColor = 'greenBright'; break;
            case 93: this._style.fgColor = 'yellowBright'; break;
            case 94: this._style.fgColor = 'blueBright'; break;
            case 95: this._style.fgColor = 'magentaBright'; break;
            case 96: this._style.fgColor = 'cyanBright'; break;
            case 97: this._style.fgColor = 'whiteBright'; break;
            case 100: this._style.bgColor = 'gray'; break;
            case 101: this._style.bgColor = 'redBright'; break;
            case 102: this._style.bgColor = 'greenBright'; break;
            case 103: this._style.bgColor = 'yellowBright'; break;
            case 104: this._style.bgColor = 'blueBright'; break;
            case 105: this._style.bgColor = 'magentaBright'; break;
            case 106: this._style.bgColor = 'cyanBright'; break;
            case 107: this._style.bgColor = 'whiteBright'; break;
          }
        }
      } else if (text && !this._style.hidden) {
        result.push({
          text: stripAnsi(text),
          style: { ...this._style, }
        });
      }
    }
    return result;
  }
}

const ansiRegex = new RegExp('[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))', 'g');
function stripAnsi(str: string): string {
  return str.replace(ansiRegex, '');
}
