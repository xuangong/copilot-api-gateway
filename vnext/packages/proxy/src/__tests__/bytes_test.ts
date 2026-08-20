/**
 * base64url helper 单测。
 *
 * 这两个 helper 是 `ss://` URI 解析和 REALITY 的 `pbk` 参数共用的转换层：
 * 两处都要接受标准 base64 和 base64url 两种拼写，且 base64url 侧的 `=`
 * 填充是可选的。用例按"解码宽松、编码严格"来钉：解码同时吃两种字母表，
 * 编码只产出无填充的 base64url。
 */
import { test, expect } from 'bun:test';
import { base64UrlDecodeBytes, base64UrlEncodeBytes, utf8Bytes } from '../bytes.ts';

const decodeToText = (s: string): string =>
  new TextDecoder().decode(base64UrlDecodeBytes(s));

test('base64UrlDecodeBytes 接受标准 base64（含 = 填充）', () => {
  expect(decodeToText('YWVzLTEyOC1nY206YWJjZA==')).toBe('aes-128-gcm:abcd');
});

test('base64UrlDecodeBytes 接受省略了 = 填充的输入', () => {
  expect(decodeToText('YWVzLTEyOC1nY206YWJjZA')).toBe('aes-128-gcm:abcd');
});

test('base64UrlDecodeBytes 把 - 和 _ 映射回 + 和 /', () => {
  // 0xfb 0xff 0xbe → 标准 base64 "+/++"，base64url 写作 "-_--"。
  expect(Array.from(base64UrlDecodeBytes('-_--'))).toEqual([0xfb, 0xff, 0xbe]);
  expect(Array.from(base64UrlDecodeBytes('+/++'))).toEqual([0xfb, 0xff, 0xbe]);
});

test('base64UrlDecodeBytes 对非法字母表输入抛错', () => {
  expect(() => base64UrlDecodeBytes('!!!')).toThrow();
});

test('base64UrlEncodeBytes 产出无填充的 base64url', () => {
  expect(base64UrlEncodeBytes(new Uint8Array([0xfb, 0xff, 0xbe]))).toBe('-_--');
  // 3 字节整除，无填充；4 字节会补两个 =，必须被剥掉。
  expect(base64UrlEncodeBytes(new Uint8Array([0xfb, 0xff, 0xbe, 0x01]))).toBe('-_--AQ');
});

test('编码 / 解码对多字节 UTF-8 往返', () => {
  const text = '密码:测试-passwörd';
  const round = decodeToText(base64UrlEncodeBytes(utf8Bytes(text)));
  expect(round).toBe(text);
});
