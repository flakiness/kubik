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

import { Text } from 'ink';
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

export function ansi2ink(text: string, defaultColors?: { bg: string, fg: string }): JSX.Element {
  const regex = /(\x1b\[(\d+(;\d+)*)m)|([^\x1b]+)/g;
  const tokens: JSX.Element[] = [];
  let match;
  let style: {
    'font-weight'?: 'bold',
    'opacity'?: string,
    'font-style'?: 'italic',
    'text-decoration'?: 'underline' | 'line-through' | 'overline',
    'display'?: 'none',
    'color'?: string,
    'background-color'?: string,
  } = {};

  let reverse = false;
  let fg: string | undefined = defaultColors?.fg;
  let bg: string | undefined = defaultColors?.bg;

  while ((match = regex.exec(text)) !== null) {
    const [, , codeStr, , text] = match;
    if (codeStr) {
      const code = +codeStr;
      switch (code) {
        case 0: style = {}; break;
        case 1: style['font-weight'] = 'bold'; break;
        case 2: style['opacity'] = '0.8'; break;
        case 3: style['font-style'] = 'italic'; break;
        case 4: style['text-decoration'] = 'underline'; break;
        case 7:
          reverse = true;
          break;
        case 8: style['display'] = 'none'; break;
        case 9: style['text-decoration'] = 'line-through'; break;
        case 22:
          delete style['font-weight'];
          delete style['font-style'];
          delete style['opacity'];
          delete style['text-decoration'];
          break;
        case 23:
          delete style['font-weight'];
          delete style['font-style'];
          delete style['opacity'];
          break;
        case 24:
          delete style['text-decoration'];
          break;
        case 27:
          reverse = false;
          break;
        case 30:
        case 31:
        case 32:
        case 33:
        case 34:
        case 35:
        case 36:
        case 37:
          fg = inkAnsiColors[code];
          break;
        case 39:
          fg = defaultColors?.fg;
          break;
        case 40:
        case 41:
        case 42:
        case 43:
        case 44:
        case 45:
        case 46:
        case 47:
          bg = inkAnsiBackgroundColors[code];
          break;
        case 49:
          bg = defaultColors?.bg;
          break;
        case 53: style['text-decoration'] = 'overline'; break;
        case 90:
        case 91:
        case 92:
        case 93:
        case 94:
        case 95:
        case 96:
        case 97:
          fg = inkAnsiColors[code];
          break;
        case 100:
        case 101:
        case 102:
        case 103:
        case 104:
        case 105:
        case 106:
        case 107:
          bg = inkAnsiBackgroundColors[code];
          break;
      }
    } else if (text && style.display !== 'none') {
      const styleCopy = { ...style };
      const color = reverse ? bg : fg;
      if (color !== undefined)
        styleCopy['color'] = color;
      const backgroundColor = reverse ? fg : bg;
      if (backgroundColor !== undefined)
        styleCopy['background-color'] = backgroundColor;

      tokens.push(
        <Text
          bold={styleCopy['font-weight'] === 'bold'}
          backgroundColor={styleCopy['background-color']}
          color={styleCopy['color']}
          dimColor={!!styleCopy['opacity']}
          italic={styleCopy['font-style'] === 'italic'}
          strikethrough={styleCopy['text-decoration'] === 'line-through'}
          underline={styleCopy['text-decoration'] === 'underline'}
        >{text}</Text>
      );
    }
  }
  return (
    <Text>{tokens}</Text>
  );
}