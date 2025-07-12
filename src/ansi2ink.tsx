import { Newline, Text } from 'ink';
import React, { JSX } from 'react';
import { ANSIToken, ANSITokenizer, ANSIStyle } from './ansiTokenizer.js';

function renderToken({ style, text }: ANSIToken): JSX.Element {
  return <Text
    bold={style.bold}
    color={style.fgColor}
    backgroundColor={style.bgColor}
    inverse={style.inverseColors}
    dimColor={style.dim}
    italic={style.italic}
    strikethrough={style.strikethrough}
    underline={style.underline}
  >{text}</Text>;
}

function renderLine(tokens: ANSIToken[], lineIdx: number): JSX.Element {
  return <Text key={lineIdx + ''}>{tokens.map(renderToken)}<Newline/></Text>
}

export class ANSI2Ink {
  private _tokenizer = new ANSITokenizer();
  
  private _text: string = '';
  private _lastLineLength = 0;
  private _lines: ANSIToken[][] = [[]];

  constructor(private _lineWidth: number) {
    this._reset();
  }

  private _reset() {
    this._text = '';
    this._lastLineLength = 0;
    this._lines = [[]];
    this._tokenizer.reset();
  }

  setLineWidth(lineWidth: number) {
    if (lineWidth === this._lineWidth)
      return;
    this._lineWidth = lineWidth;
    this._reset();
    this._layout(this._tokenizer.tokenize(this._text));
  }

  setText(text: string) {
    if (text.startsWith(this._text)) {
      const newText = text.substring(this._text.length);
      this._layout(this._tokenizer.tokenize(newText));
    } else {
      this._reset();
      this._layout(this._tokenizer.tokenize(text));
    }
    this._text = text;
  }

  private _addTokenWrapped({ style, text }: ANSIToken) {
    if (text.length && this._lineWidth === this._lastLineLength)
      this._newLine();
    while (text.length > this._lineWidth - this._lastLineLength) {
      const freeLineSpace = this._lineWidth - this._lastLineLength;
      this._lines[this._lines.length - 1].push({
        style,
        text: text.substring(0, freeLineSpace),
      });
      text = text.substring(freeLineSpace);
      this._newLine();
    }

    if (text.length) {
      this._lines[this._lines.length - 1].push({ style, text });
      this._lastLineLength += text.length;
    }
  }

  private _tab(style: ANSIStyle) {
    const tabSize = 8 - (this._lastLineLength % 8)
    if (this._lastLineLength + tabSize > this._lineWidth)
      return;
    this._lines[this._lines.length - 1].push({
      style,
      text: ' '.repeat(tabSize),
    });
    this._lastLineLength += tabSize;
  }

  private _newLine() {
    this._lines.push([]);
    this._lastLineLength = 0;
  }

  private _addLine({ text, style }: ANSIToken) {
    const tabbedTokens = text.split('\t');
    const lastToken = tabbedTokens.pop()!;
    for (const t of tabbedTokens) {
      this._addTokenWrapped({ style, text: t });
      this._tab(style);
    }
    this._addTokenWrapped({ style, text: lastToken });
  }

  private _layout(tokens: ANSIToken[]) {
    for (const token of tokens) {
      const lines = token.text.split('\n');
      const lastLine = lines.pop();
      if (lastLine === undefined)
        continue;
      for (const line of lines) {
        this._addLine({ style: token.style, text: line });
        this._newLine();
      }
      this._addLine({ style: token.style, text: lastLine });
    }
  }

  lineWidth() {
    return this._lineWidth;
  }

  lineCount() {
    return this._lines.length;
  }

  lines(from: number, to: number): JSX.Element[] {
    return this._lines.slice(from, to).map((line, index) => renderLine(line, from + index));
  }
}
