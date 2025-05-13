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
        case 30: style.fgColor = 'black'; break;
        case 31: style.fgColor = 'red'; break; 
        case 32: style.fgColor = 'green'; break;
        case 33: style.fgColor = 'yellow'; break;
        case 34: style.fgColor = 'blue'; break;
        case 35: style.fgColor = 'magenta'; break;
        case 36: style.fgColor = 'cyan'; break;
        case 37: style.fgColor = 'white'; break;
        case 39:
          delete style.fgColor;
          break;
        case 40: style.bgColor = 'black'; break;
        case 41: style.bgColor = 'red'; break;
        case 42: style.bgColor = 'green'; break;
        case 43: style.bgColor = 'yellow'; break;
        case 44: style.bgColor = 'blue'; break;
        case 45: style.bgColor = 'magenta'; break;
        case 46: style.bgColor = 'cyan'; break;
        case 47: style.bgColor = 'white'; break;
        case 49:
          delete style.bgColor;
          break;
        case 53:
          // overline; not supported.
          break;
        case 90: style.fgColor = 'gray'; break;
        case 91: style.fgColor = 'redBright'; break;
        case 92: style.fgColor = 'greenBright'; break;
        case 93: style.fgColor = 'yellowBright'; break;
        case 94: style.fgColor = 'blueBright'; break;
        case 95: style.fgColor = 'magentaBright'; break;
        case 96: style.fgColor = 'cyanBright'; break;
        case 97: style.fgColor = 'whiteBright'; break;
        case 100: style.bgColor = 'gray'; break;
        case 101: style.bgColor = 'redBright'; break;
        case 102: style.bgColor = 'greenBright'; break;
        case 103: style.bgColor = 'yellowBright'; break;
        case 104: style.bgColor = 'blueBright'; break;
        case 105: style.bgColor = 'magentaBright'; break;
        case 106: style.bgColor = 'cyanBright'; break;
        case 107: style.bgColor = 'whiteBright'; break;
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

export function ansi2ink(text: string, lineWidth: number): JSX.Element[] {
  const parsed = parseAnsiText(text);
  return renderToInk(parsed, lineWidth);
}

const ansiRegex = new RegExp('[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))', 'g');
function stripAnsi(str: string): string {
  return str.replace(ansiRegex, '');
}
