var EventEmitter = require('events').EventEmitter;

module.exports = function (options) {
  
  var status = new EventEmitter();
  
  status.onRetry = eventCreator('retry');
  status.onEnd = eventCreator('end');
  status.onError = eventCreator('error');
  status.onVerbose = eventCreator('verbose');
  
  status.onUpload = eventCreatorNested('upload');
  status.onBuild = eventCreatorNested('build');
  status.onHashing = eventCreatorNested('hashing');
  status.onFinalize = eventCreatorNested('finalize');
  status.onRelease = eventCreatorNested('release');
  status.onApp = eventCreatorNested('app');

  function eventCreatorNested (name) {
    
    return function (event, callback) {
      
      status.on(name + ':' + event, callback);
      return status;
    };
  }
  
  function eventCreator (name) {
    
    return function (callback) {
      
      status.on(name, callback);
      return status;
    };
  }
  
  return status;
};