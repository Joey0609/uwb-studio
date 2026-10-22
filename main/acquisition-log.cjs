'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** 创建目录后才打开日志；异步磁盘错误仅报告一次，不能变成主进程未捕获异常。 */
function createAcquisitionLog(directory, reportError = () => {}) {
  fs.mkdirSync(directory, {recursive:true});
  const stream = fs.createWriteStream(path.join(directory, 'acquisition.log'));
  let reported = false;
  stream.on('error', error => {
    if (reported) return;
    reported = true;
    reportError(`采集诊断日志无法写入：${error.message}`);
  });
  return stream;
}
module.exports = {createAcquisitionLog};
