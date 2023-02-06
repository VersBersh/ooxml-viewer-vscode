import {ForeignFunction, Library} from "ffi-napi";
import {types, refType, Pointer, readCString} from "ref-napi";
import {join} from 'path';


let _lib: {
  FormatXml: ForeignFunction<Pointer<number>, [string | null, number]>;
  Release: ForeignFunction<void, [Pointer<number>]>;
}

export function Load(path: string)
{
  _lib = Library(join(path, 'assets/rapidXmlFormatter.dll'), {
    FormatXml: [refType(types.char), [types.CString, types.long]],
    Release: [types.void, [refType(types.char)]],
  });
}

export function formatXml (xml: string): string
{
  // note: string length != buffer length when text isn't ASCII
  const bytes = Buffer.from(`${xml}\0`, "utf-8");
  const pChar = _lib.FormatXml(`${xml}\0`, bytes.length);
  const result = readCString(pChar);
  _lib.Release(pChar);
  return result;
}
