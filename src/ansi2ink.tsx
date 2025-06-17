import { Newline, Text } from 'ink';
import React, { JSX } from 'react';
import { ANSIStyle, ANSIToken } from './ansiTokenizer.js';

export class ANSI2Ink {
  private _lines: JSX.Element[] = [];
  private _currentLine: JSX.Element[] = [];
  private _currentLineText = '';
  private _tokens: ANSIToken[] = [];

  constructor(private _lineWidth: number) {

  }

  lineWidth() {
    return this._lineWidth;
  }

  setLineWidth(lineWidth: number) {
    if (lineWidth === this._lineWidth)
      return;
    this._lineWidth = lineWidth;
    this._lines = [];
    this._currentLine = [];
    this._currentLineText = '';
    this.addTokens(this._tokens);
  }

  lines(): JSX.Element[] {
    return this._lines;
  }

  private _flushCurrentLine() {
    this._lines.push(<Text key={this._lines.length + ''}>{this._currentLine}<Newline/></Text>)
    this._currentLine = [];
    this._currentLineText = '';
  }

  private _pushToLine(text: string, style: ANSIStyle) {
    this._currentLine.push(
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
    this._currentLineText += text;
    if (this._currentLineText.length >= this._lineWidth)
      this._flushCurrentLine();
  }

  addTokens(parsedText: ANSIToken[]) {
    if (!parsedText.length)
      return;
    this._tokens.push(...parsedText);
    for (const { text, style } of parsedText) {
      // Simplify tab rendering; instead of tabbed columns, we simply replace all tabs with 8 spaces.
      const tokenLines = text.replaceAll('\t', '        ').split('\n');
      for (let lineIdx = 0; lineIdx < tokenLines.length; ++lineIdx) {
        if (lineIdx > 0)
          this._flushCurrentLine();
        let line = tokenLines[lineIdx];
        // Handle line wrapping
        while (line) {
          let toEat = Math.min(this._lineWidth - this._currentLineText.length, line.length);
          this._pushToLine(line.substring(0, toEat), style);
          line = line.substring(toEat);
        }
      }
    }
    if (this._currentLineText)
      this._flushCurrentLine();
  }
}
