import yauzl from "yauzl";

/**
 * Read the first (and, for our sources, only) file inside a .zip and JSON.parse it.
 * @param {string} zipPath
 * @returns {Promise<any>}
 */
export function unzipSingleJson(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      let done = false;
      zip.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const chunks = [];
          stream.on("data", (c) => chunks.push(c));
          stream.on("end", () => {
            done = true;
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (parseErr) {
              reject(parseErr);
            }
            zip.close();
          });
          stream.on("error", reject);
        });
      });
      zip.on("end", () => {
        if (!done) reject(new Error(`no file entry in ${zipPath}`));
      });
      zip.readEntry();
    });
  });
}
