var fs = require('fs-extra');
var path = require('path');
var EventEmitter = require('events').EventEmitter;
var assert = require('assert');
var format = require('chalk');
var glob = require('glob');
var async = require('async');
var tmp = require('tmp');
var globby = require('globby');
var join = require('join-path');
var ask = require('ask');
var asArray = require('as-array');
var isDirectory = require('is-directory');

var statusHandler = require('./lib/status-handler');
var syncTree = require('./lib/sync-tree');

var DIVSHOT_API_VERSION = '0.5.0';
var DIVSHOT_API_HOST = 'https://api.divshot.com';
var DEFAULT_ENVIRONMENT = 'development';
var DEFAULT_AWS_REGION = 'us-east-1';

module.exports = function push (options) {
  
  // Set up status events
  var status = statusHandler();
  
  // Ensure required data
  assert.ok(options.config, '[divshot-push]: Application configuration data is required');
  assert.ok(options.token, '[divshot-push]: User authentication token is required');
  
  // Set up options
  var environment = options.environment || DEFAULT_ENVIRONMENT;
  var config = options.config;
  var token = options.token;
  var timeout = options.timeout;
  var appConfigRootPath = (config.root && config.root === '/') ? './' : config.root;
  var appRootDir = path.resolve(options.root || '/', appConfigRootPath);
  var apiHost = (options.hosting) ? options.hosting.api.host || DIVSHOT_API_HOST : DIVSHOT_API_HOST;
  var apiVersion = (options.hosting) ? options.hosting.api.version || DIVSHOT_API_VERSION : DIVSHOT_API_VERSION;
  
  // Set up api calls
  var api = ask({
    origin: apiHost,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept-Version': apiVersion
    }
  });
  
  var createApp = api.post('apps')
  
  // Use nextTick because we need to listen for events
  // outside the module before we start emitting the events
  process.nextTick(function () {
    startDeploy(config);
  });
  
  function startDeploy (config) {
    
    if (!fs.existsSync(appRootDir)) {
      return status.emit('error', 'directory does not exist');
    }
    
    if (environment === 'production') {
      status.emit('log', '\n' + format.yellow('Note:') + ' Deploying to production purges your application\'s CDN cache, which may take up to one minute.\n');
    }
    
    status.emit('log', 'Creating build ... ');
    
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
          status.emit('log', 'Unexpected build data.\n');
          status.emit('log', format.red.underline('====== Build Data Start ======\n'));
          status.emit('log', JSON.stringify(build, null, 4) + '\n');
          status.emit('log', format.red.underline('====== Build Data End ======\n'));
          status.emit('log', '');
          
          return status.emit('error', 'Contact support@divshot.com with this data for diagnostic purposes.');
        }
        
        status.emit('log', format.green('✔') + '\n');
        
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
      
      status.emit('log', 'Hashing Directory Contents ...');
      
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
            bucket: process.env.DIVSHOT_HASHED_BUCKET,
            prefix: build.application_id
          });

          sync.on('inodecount', function(count) {
            
            status.emit('log', format.green(' ✔') + '\n');
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
          });

          sync.on('retry', function(error) {
            
            status.emit('retry');
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
            
            status.emit('log', '\n');
            status.emit('log', 'Finalizing build ... ');
            
            finalizeBuild({file_map: fileMap})
              .then(function (res) {
                
                status.emit('log', format.green('✔') + '\n');
                status.emit('log', 'Releasing build to ' + format.bold(environment) + ' ... ');
                
                return releaseBuild({build: build.id})
              })
              .then(function (res) {
                
                status.emit('log', format.green('✔') + '\n');
                
                // TODO: should not hard code this
                var appUrl = (environment === 'production') 
                  ? 'http://' + config.name + '.divshot.io'
                  : 'http://' + environment + '.' + config.name + '.divshot.io';
                
                status.emit('log', '\n');
                status.emit('log', 'Application deployed to ' + format.bold.white(environment) + '\n');
                status.emit('log', 'You can view your app at: ' + format.bold(appUrl) + '\n');
                
                status.emit('end', appUrl);
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
    
    status.emit('log', '\n');
    status.emit('log', 'App does not yet exist. Creating app ' + format.bold(config.name) + ' ... ');
    
    createApp({name: config.name.toLowerCase()})
      .then(function (res) {
        
        deploy(config);
      })
      .catch(function (err) {
        
        status.emit('error', (err.body) ? err.body.error: err);
      });
  }
  
  function filesToUpload (appRootDir, filesToExclude) {
    
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
  
  // Handle verbose data for debugging
  function verbose() {
    status.emit('verbose', asArray(arguments));
  }
  
  // Return event emitter
  return status;
};