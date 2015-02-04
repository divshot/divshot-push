# divshot-push

Deploy files to the Divshot hosting platform.

## Install

```
npm install divshot-push --save
```

## Usage

The following usage example pushes all files from the current directory up to Divshot.

```js
var push = require('divshot-push');

var pushStatus = push({
  root: process.cwd(),
  environment: 'development',
  config: {
    name: 'app-name'
  },
  token: 'user auth token',
});

pushStatus.onUpload('start', function () {
  console.log('Upload started ...'); 
});

pushStatus.onUpload('end', function () {
  console.log('Complete!');
});
```

## API

### push(options)

* `options`
  * `root` - REQUIRED: Full path the directory to push.
  * `config` - REQUIRED: App configuration data.
  * `token` - REQUIRED: User authentication token.
  * `environment` - OPTIONAL: Environment to push to. Defaults to `development`.
  * `timeout` - OPTIONAL: API http request timeout.
  * `cacheDirectory` - OPTIONAL: name of directory to store the caching hash files. Defaults to `.divshot-cache/deploy`

### Push Status Events

The `push` method returns a set of event emitting methods to listen for various push status updates:

#### onEnd(callback)

The full push process is complete.

* `callback` - Function to execute on event.

#### onError(callback)

There was an error pushing the app.

* `callback` - Function to execute on event.

#### onVerbose(callback)

Verbose logging for debugging purposes.

* `callback` - Function to execute on event.

#### onUpload(event, callback)

Events emitted while uploading files.

* `event` - Event to listen for.
* `callback` - Function to execute on event.

Emitted upload events:

* `start` - Uploaded has started. Callback is given count of files to upload.
* `progress` - Emitted on file uploaded. Callback is given number of files uplaoded for this progress event.
* `end` - Upload complete.
* `error` - Error uploading files. Callback is given error object.

#### onBuild(event, callback)

Events emitted while creating an application build.

* `event` - Event to listen for.
* `callback` - Function to execute on event.

Emitted build events:

* `start` - Build has started.
* `end` - Build complete. Callback is given the build object.

#### onHashing(event, callback)

Events emitted while hashing files for syncing on Divshot's servers.

* `event` - Event to listen for.
* `callback` - Function to execute on event.

Emitted hashing events:

* `start` - Hashing has started.
* `end` - Hashing is complete.

#### onRelease(event, callback)

Events emitted while a release is being created.

* `event` - Event to listen for.
* `callback` - Function to execute on event.

Emitted releasing events:

* `start` - Releasing has started. Callback is passed the envrionment the app is being released to.
* `end` - Releasing is complete.

#### onFinalize(event, callback)

Events emitted while release is being finalized.

* `event` - Event to listen for.
* `callback` - Function to execute on event.

Emitted finalizing events:

* `start` - Finalizing has started.
* `end` - Finalizing is complete.

#### onApp(event, callback)

Events emitted if/when an app needs to be created before files are pushed.

* `event` - Event to listen for.
* `callback` - Function to execute on event.

Emitted App events:

* `create` - App is being created. Callback is passed the name of the app.
* `end` - App has been created. Callback is passed the app object.
