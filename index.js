var fs = require('fs-extra');
var path = require('path');
var EventEmitter = require('events').EventEmitter;
var format = require('chalk');
var _ = require('lodash');
var glob = require('glob');
var async = require('async');
var tmp = require('tmp');
var ProgressBar = require('progress');
var globby = require('globby');
var join = require('join-path');
var syncTree = require('./lib/sync-tree');
var ask = require('ask');

var DIVSHOT_API_VERSION = '0.5.0';
var DIVSHOT_API_HOST = 'https://api.divshot.com';

module.exports = function push (options, done) {
  
  // Set up optiosn
  var environment = options.environment || 'development';
  var config = options.config;
  var token = options.token;
  var appConfigRootPath = (config.root && config.root === '/') ? './' : config.root;
  var appRootDir = path.resolve(process.cwd(), appConfigRootPath);
  var apiHost = (options.origin) ? options.origin.host || DIVSHOT_API_HOST : DIVSHOT_API_HOST;
  
  // Set up api calls
  var api = ask({
    origin: apiHost,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept-Version': DIVSHOT_API_VERSION
    }
  });
  
  if (!fs.existsSync(appRootDir)) {
    return done(new Error('directory does not exist'));
  }
  
  if (environment === 'production') {
    console.log('\n' + format.yellow('Note:') + ' Deploying to production purges your application\'s CDN cache, which may take up to one minute.\n');
  }
  
  process.stdout.write('Creating build ... ');
  
  // Start deployment process
  deploy(config);
  
  function createAppBeforeBuild (config) {
    
    console.log('');
    process.stdout.write('App does not yet exist. Creating app ' + format.bold(config.name) + ' ... ');
    
    cli.api.apps.create(config.name.toLowerCase(), function (err, response, body) {
      
      if (err) return onError(err);
      if (response.error === 'invalid_token') return done(cli.errors.NOT_AUTHENTICATED);
      if (body.error) return onError(body);
      if (response.statusCode >= 400) return onError(body);

      deploy(config);
    });
  }
  
  function deploy (config) {
    
    var createBuild = api.post('apps', config.name, 'builds');
    
    createBuild({
      config: config
    })
      .then(function (res) {
        
        console.log('THEN');
        console.log(res.body);
      })
      .catch(function (err) {
        
        console.log('CATCH');
        console.log(err.body);
      });
    
    return;
    
    // 4. Copy files (minus exclusions) to a tmp dir
    
    cli.api.apps.id(config.name).builds.create({config: config}, function(err, build){
      
      if (err) return onError(err);
      
      // App doesn't exist, create it
      if (build && build.status == 404) return createAppBeforeBuild(config);
      
      // Not allowed
      if (build && build.status == 401) return onError(build);
      
      // Any other error
      if (build && build.status) return onError(err);
      
      // Does this user have access to this app?
      if (build && build.error) return onError(build);
      
      if (!build.loadpoint) {
        console.log('Unexpected build data.');
        console.log(format.red.underline('====== Build Data Start ======'));
        console.log(JSON.stringify(build, null, 4));
        console.log(format.red.underline('====== Build Data End ======'));
        console.log();
        return done('Contact support@divshot.com with this data for diagnostic purposes.');
      }

      console.log(format.green('✔'));
      console.log('');
     
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
              region: 'us-east-1',
              httpOptions: {
                timeout: cli.timeout
              }
            },
            directory: [tmpDir, build.id].join('/'),
            bucket: process.env.DIVSHOT_HASHED_BUCKET,
            prefix: build.application_id
          });

          var inodeCount;
          var visitedCount = 0;

          var progressBar;

          function verbose() {
            // console.log.apply(console, arguments);
          }

          process.stdout.write('Hashing Directory Contents ...');

          sync.on('inodecount', function(count) {
            
            process.stdout.write(format.green(' ✔\n'));
            progressBar = new ProgressBar('Syncing '+ count +' inodes: [' + format.green(':bar') + '] ' + format.bold(':percent') + '', {
              complete: '=',
              incomplete: ' ',
              width: 50,
              total: count
            });
            inodeCount = count;
          });

          sync.on('notfound', function(path, hash) {
            
            verbose(format.red('404 ') + path);
          });

          sync.on('found', function(path, hash, count) {
            
            verbose(format.green('200 ') + path)
            visitedCount += count;
            progressBar.tick(count);
          });

          sync.on('cachestart', function(path, hash) {
            
            verbose(format.blue('PUT ') + path)
          });

          sync.on('cachesuccess', function(path, hash, count) {
            
            verbose(format.green('201 ') + path);
            visitedCount += 1;
            progressBar.tick(1);
          });

          sync.on('uploadstart', function(path, hash) {
            
            verbose(format.blue('PUT ') + path);
          });

          sync.on('uploadsuccess', function(path, hash) {
            
            verbose(format.green('201 ') + path);
            visitedCount += 1;
            progressBar.tick(1);
          });

          sync.on('uploadfailure', function(error) {
            
          });

          sync.on('retry', function(error) {
            
            visitedCount = 0;
            console.log('');
            console.log(format.red.underline(error.message));
            console.log(format.green.underline('Retrying...'))
          });

          sync.on('error', function(error) {
            
            console.log('');
            console.log(format.red.underline(error.message));
            console.log(error.stack);
            process.exit(1);
          });

          sync.on('synced', function(fileMap) {
            
            console.log(format.green('Synced!'));
            verbose('inodeCount: ' + inodeCount, 'visitedCount: ' + visitedCount);

            var buildApi = cli.api.apps.id(config.name).builds.id(build.id);
            
            console.log('');
            process.stdout.write('Finalizing build ... ');

            var url = buildApi.url() + '/finalize';

            buildApi.http.request(url, 'PUT', {json:{file_map: fileMap}}, function (err, response) {
              
              if (err) return onError(err);
              if (response.statusCode < 200 || response.statusCode >= 300) {
                var res = {};

                try {res = JSON.parse(response.body);}
                catch (e) {}
                
                console.log();
                return onError(error);
              }

              console.log(format.green('✔'));
              process.stdout.write('Releasing build to ' + format.bold(environment) + ' ... ');

              buildApi.release(environment, function (err, response) {
                
                if (err) return onError(err);
                
                console.log(format.green('✔'));
                
                return onPushed();
              });
            });

          });
        });
      });
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
  
  function isDirectory (pathname) {
    
    return fs.existsSync(pathname)
      && fs.statSync(pathname).isDirectory();
  }

  function onPushed () {
    
    var appUrl = (environment === 'production') 
      ? 'http://' + config.name + '.divshot.io'
      : 'http://' + environment + '.' + config.name + '.divshot.io';
    
    console.log('');
    console.log('Application deployed to ' + format.bold.white(environment), {success: true});
    console.log('You can view your app at: ' + format.bold(appUrl), {success: true});
    
    done(null, appUrl);
  }
  
  function onError(err) {
    
    var errorMessage = err;
    
    if (_.isObject(err)) errorMessage = err.error;
    
    console.log();
    
    done(errorMessage);
  }
};