var EventEmitter = require('events').EventEmitter;

module.exports = function (options) {
  
  var status = new EventEmitter();
  
  status.onUpload = function (event, callback) {
    
    status.on('upload:' + event, callback);
    
    return status;
  };
  
  status.onRetry = function (callback) {
    
    status.on('retry', callback);
    
    return status;
  };
  
  status.onEnd = function (callback) {
    
    status.on('done', callback);
    status.on('end', callback);
    
    return status;
  };
  
  status.onOutput = function (callback) {
    
    status.on('log', callback);
    
    return status;
  };
  
  status.onError = function (callback) {
    
    status.on('error', callback);
    
    return status;
  };

  return Object.freeze(status);
};