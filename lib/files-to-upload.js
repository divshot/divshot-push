var path = require('path');
var join = require('join-path');
var globby = require('globby');
var isDirectory = require('is-directory');

module.exports = function filesToUpload (appRootDir, filesToExclude) {
  
  // 1. glob directory appRootDir
  // 2. array subtract globs of config.excludes
  
  var globs = [appRootDir + "/**"];
  
  if (filesToExclude) {
    filesToExclude.forEach(function(excludeGlob) {
      
      var pathname = join(appRootDir, excludeGlob);
      var excludePath = join('!' + appRootDir, excludeGlob);
      
      if (isDirectory(pathname)) {
        excludePath += path.sep + '**';
      }
      
      globs.push(excludePath);
    });
  }
  
  return globby.sync(globs);
}