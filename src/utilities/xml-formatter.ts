import { FormatOptions, formatXml, minifyXml } from 'pretty-fast-xml';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * The xml formatter.
 */
export class XmlFormatter {
  static isXml(data: Uint8Array) {
    const text = textDecoder.decode(data);
    return text.startsWith('<?xml');
  }

  /**
   * Formats a binary array if it's xml.
   *
   * @param data {Uint8Array} The data to format.
   * @returns {Uint8Array} The formatted xml.
   */
  static format(data: Uint8Array): Uint8Array {
    if (!XmlFormatter.isXml(data)) {
      return data;
    }

    const result = formatXml(textDecoder.decode(data));
    return result.succeeded ? textEncoder.encode(result.formatted) : data;
  }

  /**
   * Minifies a binary array if it's xml.
   *
   * @param {Uint8Array} data The unminified xml.
   * @returns {Uint8Array} The minified xml.
   */
  static minify(data: Uint8Array, preserveComments: boolean): Uint8Array {
    if (!XmlFormatter.isXml(data)) {
      return data;
    }

    const text = textDecoder.decode(data);

    const options: FormatOptions = {
      removeComments: !preserveComments,
    };

    const result = minifyXml(text, options);

    return result.succeeded ? textEncoder.encode(result.formatted) : data;
  }

  /**
   * Check if two xml binary arrays are the same.
   *
   * @param {Uint8Array} xmlContent1 the first xml content to compare.
   * @param {Uint8Array} xmlContent2 The second xml content to compare.
   * @returns {boolean} A Promise resolving to whether or not the xml contents are the same.
   */
  static areEqual(xmlContent1: Uint8Array, xmlContent2: Uint8Array): boolean {
    if (Buffer.from(xmlContent1).equals(Buffer.from(xmlContent2))) {
      return true;
    }

    const fileMinXml = XmlFormatter.minify(xmlContent1, true);
    const prevFileMinXml = XmlFormatter.minify(xmlContent2, true);

    if (Buffer.from(fileMinXml).equals(Buffer.from(prevFileMinXml))) {
      return true;
    }

    return false;
  }
}
