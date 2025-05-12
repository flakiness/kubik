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

import { Newline, Text } from 'ink';
import React, { JSX } from 'react';

// Standard ANSI color names that INK/Chalk understands
const inkAnsiColors: { [code: number]: string } = {
  30: 'black',
  31: 'red',
  32: 'green',
  33: 'yellow',
  34: 'blue',
  35: 'magenta',
  36: 'cyan',
  37: 'white',
  // Bright colors
  90: 'gray', // or 'grey', 'blackBright'
  91: 'redBright',
  92: 'greenBright',
  93: 'yellowBright',
  94: 'blueBright',
  95: 'magentaBright',
  96: 'cyanBright',
  97: 'whiteBright',
};

const inkAnsiBackgroundColors: { [code: number]: string } = {
  40: 'black',
  41: 'red',
  42: 'green',
  43: 'yellow',
  44: 'blue',
  45: 'magenta',
  46: 'cyan',
  47: 'white',
  // Bright background colors
  100: 'gray', // or 'grey', 'blackBright'
  101: 'redBright',
  102: 'greenBright',
  103: 'yellowBright',
  104: 'blueBright',
  105: 'magentaBright',
  106: 'cyanBright',
  107: 'whiteBright',
};

type ANSIStyle = {
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

type ParsedToken = {
  text: string,
  style: ANSIStyle,
};

function parseAnsiText(text: string): ParsedToken[] {
  const regex = /(\x1b\[(\d+(;\d+)*)m)|([^\x1b]+)/g;
  const result: ParsedToken[] = [];

  let match;
  let style: ANSIStyle = {};

  while ((match = regex.exec(text)) !== null) {
    const [, , codeStr, , text] = match;
    if (codeStr) {
      const code = +codeStr;
      switch (code) {
        case 0:
          style = {};
          break;
        case 1: style.bold = true; break;
        case 2: style.dim = true; break;
        case 3: style.italic = true; break;
        case 4: style.underline = true; break;
        case 7:
          style.inverseColors = true;
          break;
        case 8: style.hidden = true; break;
        case 9: style.strikethrough = true; break;
        case 22:
          style.dim = false;
          style.bold = false;
          break;
        case 23:
          style.italic = false;
          break;
        case 24:
          style.underline = false;
          break;
        case 27:
          style.inverseColors = false;
          break;
        case 30:
        case 31:
        case 32:
        case 33:
        case 34:
        case 35:
        case 36:
        case 37:
          style.fgColor = inkAnsiColors[code];
          break;
        case 39:
          delete style.fgColor;
          break;
        case 40:
        case 41:
        case 42:
        case 43:
        case 44:
        case 45:
        case 46:
        case 47:
          style.bgColor = inkAnsiBackgroundColors[code];
          break;
        case 49:
          delete style.bgColor;
          break;
        case 53:
          // overline; not supported.
          break;
        case 90:
        case 91:
        case 92:
        case 93:
        case 94:
        case 95:
        case 96:
        case 97:
          style.fgColor = inkAnsiColors[code];
          break;
        case 100:
        case 101:
        case 102:
        case 103:
        case 104:
        case 105:
        case 106:
        case 107:
          style.bgColor = inkAnsiBackgroundColors[code];
          break;
      }
    } else if (text && !style.hidden) {
      result.push({
        text: stripAnsi(text),
        style: { ...style, }
      });
    }
  }
  return result;
}

function renderToInk(parsedText: ParsedToken[], lineWidth: number): JSX.Element[] {
  const result: JSX.Element[] = [];
  let currentLineText = '';
  let currentLine: JSX.Element[] = [];

  const flushCurrentLine = () => {
    result.push(<Text key={result.length + ''}>{currentLine}<Newline/></Text>)
    currentLine = [];
    currentLineText = '';
  }

  const pushToLine = (text: string, style: ANSIStyle) => {
    currentLine.push(
      <Text
        bold={style.bold}
        color={style.fgColor}
        backgroundColor={style.bgColor}
        inverse={style.inverseColors}
        dimColor={style.dim}
        italic={style.italic}
        strikethrough={style.strikethrough}
        underline={style.underline}
      >{text}</Text>
    );
    currentLineText += text;
    if (currentLineText.length >= lineWidth)
      flushCurrentLine();
  }

  for (const { text, style } of parsedText) {
    const tokenLines = text.replaceAll('\t', '       ').split('\n');
    for (let lineIdx = 0; lineIdx < tokenLines.length; ++lineIdx) {
      if (lineIdx > 0 && currentLineText)
        flushCurrentLine();
      let line = tokenLines[lineIdx];
      // Handle line wrapping
      while (line) {
        let toEat = Math.min(lineWidth - currentLineText.length, line.length);
        pushToLine(line.substring(0, toEat), style);
        line = line.substring(toEat);
      }
    }
  }
  if (currentLineText)
    flushCurrentLine();
  return result;
}

export function ansi2ink(text: string, lineWidth: number, defaultColors?: { bg: string, fg: string }): JSX.Element[] {
  const parsed = parseAnsiText(text);
  return renderToInk(parsed, lineWidth);
}

const ansiRegex = new RegExp('[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))', 'g');
function stripAnsi(str: string): string {
  return str.replace(ansiRegex, '');
}
