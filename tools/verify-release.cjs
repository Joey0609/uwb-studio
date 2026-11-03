'use strict';
/** @brief 发布前校验安装包、差分包与自动更新清单，避免发布不完整更新。 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),yaml=require('js-yaml');
const pkg=require('../package.json'),dir=path.resolve(__dirname,'../release');
if(process.env.RELEASE_TAG&&process.env.RELEASE_TAG!=='v'+pkg.version)throw Error('Release tag must match package version');
const manifest=yaml.load(fs.readFileSync(path.join(dir,'latest.yml'),'utf8'));
if(String(manifest.version)!==pkg.version||!manifest.files?.length)throw Error('Invalid update manifest');
for(const file of manifest.files){const name=decodeURIComponent(file.url);if(!/^UWB-Studio-Setup-[\d.]+-x64\.exe$/.test(name))throw Error('Unexpected installer name');const bytes=fs.readFileSync(path.join(dir,name));if(crypto.createHash('sha512').update(bytes).digest('base64')!==file.sha512||bytes.length!==file.size)throw Error('Installer checksum mismatch');if(!fs.existsSync(path.join(dir,name+'.blockmap')))throw Error('Missing blockmap');}
console.log('Installer, latest.yml and differential blockmap verified for v'+pkg.version);
