var fs = require('fs-extra');
var path = require('path');
var EventEmitter = require('events').EventEmitter;
var assert = require('assert');
var format = require('chalk');
var async = require('async');
var tmp = require('tmp');
var ask = require('ask');
var asArray = require('as-array');
var dumper = require('divshot-dumper');

var statusHandler = require('./lib/status-handler');
var syncTree = require('./lib/sync-tree');
var filesToUpload = require('./lib/files-to-upload');

var DIVSHOT_API_VERSION = '0.5.0';
var DIVSHOT_API_HOST = 'https://api.divshot.com';
var DEFAULT_ENVIRONMENT = 'development';
var DEFAULT_AWS_REGION = 'us-east-1';
var DEFAULT_AWS_BUCKET = 'divshot-io-hashed-production';
var CACHE_DIRECTORY = '.divshot-cache/deploy';

module.exports = function push (options) {
  
  // Set up status events stream
  var status = statusHandler();
  
  // Ensure required data
  assert.ok(options.config, '[divshot-push]: Application configuration data is required');
  assert.ok(options.token, '[divshot-push]: User authentication token is required');
  
  // Set up options
  var environment = options.environment || DEFAULT_ENVIRONMENT;
  var config = options.config;
  var token = options.token;
  var timeout = options.timeout;
  var awsBucket = (options.bucket) ? options.hosting.bucket || DEFAULT_AWS_BUCKET : DEFAULT_AWS_BUCKET;
  var appConfigRootPath = (config.root && config.root === '/') ? './' : config.root || './';
  var appRootDir = path.resolve(options.root || '/', appConfigRootPath);
  var apiHost = (options.hosting) ? options.hosting.api.host || DIVSHOT_API_HOST : DIVSHOT_API_HOST;
  var apiVersion = (options.hosting) ? options.hosting.api.version || DIVSHOT_API_VERSION : DIVSHOT_API_VERSION;
  var cacheDirectory = options.cacheDirectory || CACHE_DIRECTORY;
  
  // Set up api calls
  var api = ask({
    origin: apiHost,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept-Version': apiVersion
    }
  });
  
  // Log output on error
  dumper(api.events);
  
  var createApp = api.post('apps');
  
  // Use nextTick because we need to listen for events
  // outside the module before we start emitting the events
  process.nextTick(function () {
    
    startDeploy(config);
  });
  
  function startDeploy (config) {
    
    if (!fs.existsSync(appRootDir)) {
      return status.emit('error', 'The directory ' + format.bold(appRootDir) + ' does not exist');
    }
    
    status.emit('build:start');
    
    // Start deployment process
    deploy(config);
  }
  
  function deploy (config) {
    
    var createBuild = api.post('apps', config.name, 'builds');
    
    createBuild({config: config})
      .then(function (res) {
        
        var build = res.body;
        
        // Any other error
        if (build.status || build.error) {
          return status.emit('error', res.body.error);
        }
        
        // Unexptected error
        if (!build.loadpoint) {
          var errorMsg = '';
          errorMsg += 'Unexpected build data.\n';
          errorMsg += format.red.underline('====== Build Data Start ======\n');
          errorMsg += JSON.stringify(build, null, 4) + '\n';
          errorMsg += format.red.underline('====== Build Data End ======\n');
          errorMsg += '\nContact support@divshot.com with this data for diagnostic purposes.';
          
          return status.emit('error', errorMsg);
        }
        
        status.emit('build:end', build);
        startUpload(config, build);
      })
      .catch(function (err) {
        
        // App doesn't exist yet, create it first
        if (err.statusCode === 404) {
          return createAppBeforeBuild(config);
        }
        
        if (err.statusCode === 401) {
          return status.emit('error', err.body.error);
        }
        
        status.emit('error', (err.body) ? err.body.error: err);
      });
    
    
    // 4. Copy files (minus exclusions) to a tmp dir
    
    function startUpload (config, build) {
      
      status.emit('hashing:start');
      
      tmp.dir({unsafeCleanup: true}, function(err, tmpDir) {
        
        async.map(filesToUpload(appRootDir, config.exclude), function(src, callback){
          
          // This seems to be the main place path seperators are getting us into trouble.
          var _appRootDir = appRootDir.replace(/\\/g, '/');
          src = src.replace(/\\/g, '/');

          if (fs.statSync(src).isDirectory()) { callback(); return; };
          var dest = src.replace(_appRootDir, tmpDir + "/" + build.id).replace(/\\/g, '/');
          fs.ensureFileSync(dest);
          fs.copySync(src, dest);
          callback()  ;
        }, function() {

          // 5. get the STS token for the build formatted for our S3 lib
          var authorization = JSON.parse(new Buffer(build.loadpoint.authorization, 'base64'));
          
          // 6. upload files syncTree
          var directory = [tmpDir, build.id].join('/');
          
          var sync = syncTree({
            clientOptions: {
              secretAccessKey: authorization.secret,
              accessKeyId: authorization.key,
              sessionToken: authorization.token,
              region: DEFAULT_AWS_REGION,
              httpOptions: {
                timeout: timeout
              }
            },
            directory: [tmpDir, build.id].join('/'),
            bucket: process.env.DIVSHOT_HASHED_BUCKET || awsBucket,
            prefix: build.application_id,
            cacheDirectory: cacheDirectory
          });

          sync.on('inodecount', function(count) {
            
            status.emit('hashing:end');            
            status.emit('file:count', count);
            status.emit('upload:start', count);
          });

          sync.on('notfound', function(path, hash) {
            
            status.emit('notfound');
            verbose(format.red('404 ') + path);
          });

          sync.on('found', function(path, hash, count) {
            
            status.emit('file:found', count);
            status.emit('upload:progress', count);
            verbose(format.green('200 ') + path);
          });

          sync.on('cachestart', function(path, hash) {
            
            status.emit('file:cachestart');
            verbose(format.blue('PUT ') + path);
          });

          sync.on('cachesuccess', function(path, hash, count) {
            
            status.emit('file:cachesuccess');
            status.emit('upload:progress', 1);
            verbose(format.green('201 ') + path);
          });

          sync.on('uploadsuccess', function(path, hash) {
            
            status.emit('upload:success');
            status.emit('upload:progress', 1);
            status.emit('upload:end');
            verbose(format.green('201 ') + path);
          });

          sync.on('uploadfailure', function(err) {
            
            status.emit('upload:failure', err);
            status.emit('upload:error', err);
          });

          sync.on('retry', function(err) {
            
            status.emit('upload:retry', err);
          });

          sync.on('error', function(err) {
            
            status.emit('error', err);
          });

          sync.on('synced', function(fileMap) {
            
            status.emit('upload:start', Object.keys(fileMap).length);
            status.emit('upload:end');
            
            var finalizeBuild = api.put(
              'apps',
              config.name.toLowerCase(),
              'builds',
              build.id,
              'finalize'
            );
            
            var releaseBuild = api.post(
              'apps',
              config.name.toLowerCase(),
              'releases',
              environment
            );
            
            status.emit('finalize:start');
            
            finalizeBuild({file_map: fileMap})
              .then(function (res) {
                
                status.emit('finalize:end');
                status.emit('release:start', environment);
                
                return releaseBuild({build: build.id})
              })
              .then(function (res) {
                
                status.emit('release:end');
                
                // TODO: should not hard code this
                var appUrl = (environment === 'production') 
                  ? 'http://' + config.name + '.divshot.io'
                  : 'http://' + environment + '.' + config.name + '.divshot.io';
                
                status.emit('end', {
                  url: appUrl,
                  environment: environment
                });
              })
              .catch(function (err) {
                
                status.emit('error', (err.body) ? err.body.error: err);
              });
          });
        });
      });
    }
  }
  
  function createAppBeforeBuild (config) {
    
    status.emit('app:create', config.name);
    
    createApp({name: config.name.toLowerCase()})
      .then(function (res) {
        
        status.emit('app:end', res.body);
        deploy(config);
      })
      .catch(function (err) {
        
        status.emit('error', (err.body) ? err.body.error: err);
      });
  }
  
  // Handle verbose data for debugging
  function verbose() {
    
    status.emit('verbose', asArray(arguments));
  }
  
  // Return event emitter
  return status;
};