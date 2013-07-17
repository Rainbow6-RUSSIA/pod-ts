var fs      = require('fs'),
    path    = require('path'),
    util    = require('util'),
    async   = require('async'),
    colors  = require('colors'),
    Satan   = require('pm2/lib/Satan'),
    cst     = require('pm2/constants'),
    exec    = require('child_process').exec,
    Emitter = require('events').EventEmitter

var globalConfig,
    globalConfigPath = process.env.HOME + '/.podrc'

var testing = false,
    rawAppnameRE = '/apps/(.+)/.+\.js'

var api = new Emitter()
process.on('satan:client:ready', function () {
    api.emit('ready')
})

api.createApp = function (appname, options, callback) {

    if (typeof options === 'function') {
        callback = options
        options = null
    }

    if (globalConfig.apps[appname]) {
        return callback(new Error('an app with that name already exists.'))
    }

    var paths = getAppPaths(appname)
    async.parallel([
        function (done) {
            // write config file
            var opts = {}
            // merge options
            if (options) {
                for (var o in options) {
                    opts[o] = options[o]
                }
            }
            globalConfig.apps[appname] = opts
            var data = JSON.stringify(globalConfig, null, 4)
            fs.writeFile(globalConfigPath, data, function (err) {
                done(err, 'updated config.')
            })
        },
        function (done) {
            // create log directory
            fs.mkdir(paths.logPath, function (err) {
                done(err, 'created logs dir at ' + paths.logPath.yellow)
            })
        },
        function (done) {
            // create repo
            createAppRepo(paths, done)
        }
    ],
    function (err, msgs) {
        var repoMsgs = msgs.pop()
        msgs = msgs.concat(repoMsgs)
        callback(err, msgs, api.getAppInfo(appname))
    })
}

api.removeApp = function (appname, callback) {
    
    var app = api.getAppInfo(appname)
    if (!app) {
        return callback(new Error('app ' + appname.yellow + ' does not exist.'))
    }

    api.stopApp(appname, function (err) {
        if (!err || /is not running/.test(err.toString())) {
            async.parallel([
                function (done) {
                    // remove files
                    exec('rm -rf ' +
                        app.repoPath + ' ' +
                        app.workPath + ' ' +
                        app.logPath,
                        done
                    )
                },
                function (done) {
                    // rewrite config
                    delete globalConfig.apps[appname]
                    var data = JSON.stringify(globalConfig, null, 4)
                    fs.writeFile(globalConfigPath, data, done)
                }
            ],
            function (err) {
                if (err) return callback(err)
                callback(null, 'deleted app: ' + appname.yellow)
            })
        } else {
            callback(err)
        }
    })

}

api.startApp = function (appname, callback) {
    var app = api.getAppInfo(appname)
    if (!app) {
        return callback(new Error('app ' + appname.yellow + ' does not exist.'))
    }
    fs.exists(app.script, function (exists) {
        if (!exists) {
            return callback(new Error('cannot locate main script for ' + appname.yellow + '\n' +('(' + app.script + ')').grey))
        }
        Satan.executeRemote('findByScript', {script: app.script}, function (err, proc) {
            if (err) return callback(err)
            if (proc) return callback(null, appname.yellow + ' already running.')

            var appConf = prepareConfig(app)
            appConf.NODE_ENV = app.config.nodeEnv || globalConfig.nodeEnv
            if (app.config.port) appConf.PORT = app.config.port

            Satan.executeRemote('prepare', appConf, function (err) {
                if (err) return callback(err)
                callback(null, appname.yellow + ' running on ' + app.port)
            })
        })
    })
}

api.startAllApps = function (callback) {
    async.map(
        Object.keys(globalConfig.apps),
        api.startApp,
        callback
    )
}

api.stopApp = function (appname, callback) {
    var app = api.getAppInfo(appname)
    if (!app) {
        return callback(new Error('app ' + appname.yellow + ' does not exist.'))
    }
    Satan.executeRemote('findByScript', {script: app.script}, function (err, proc) {
        if (err) return callback(err)
        if (!proc) return callback(null, appname.yellow + ' is not running')
        Satan.executeRemote('stopId', { id: proc.pm_id }, function (err) {
            if (err) return callback(err)
            callback(null, appname.yellow + ' stopped.')
        })
    })
}

api.stopAllApps = function (callback) {
    // only stop ones in the config
    async.map(
        Object.keys(globalConfig.apps),
        api.stopApp,
        callback
    )
}

api.restartApp = function (appname, callback) {
    var app = api.getAppInfo(appname)
    if (!app) {
        return callback(new Error('app ' + appname.yellow + ' does not exist'))
    }
    Satan.executeRemote('list', {}, function (err, list) {
        if (err) return callback(err)
        var inList = false
        for (var i = 0, l = list.length; i < l; i++) {
            if (list[i].opts.name === appname) {
                restart(list[i], callback)
                inList = true
            }
        }
        if (!inList) callback(new Error(appname.yellow + ' is not running'))
    })
}

api.restartAllApps = function (callback) {
    Satan.executeRemote('list', {}, function (err, list) {
        if (err) return callback(err)
        async.map(list, function (proc, done) {
            if (proc.opts.name in globalConfig.apps) {
                restart(proc, done)
            } else {
                done()
            }
        }, callback)
    })
}

api.listApps = function (callback) {
    var apps = Object.keys(globalConfig.apps)
    if (!apps.length) {
        return callback(null, [])
    }
    Satan.executeRemote('list', {}, function (err, list) {
        if (err) return callback(err)
        callback(null, apps.map(function (appname) {
            var app = api.getAppInfo(appname)
            app.isRunning = isRunning(appname, list)
            return app
        }))
    })
}

api.cleanAppLog = function (appname, callback) {
    var app = api.getAppInfo(appname)
    if (!app) {
        return callback(new Error('app ' + appname.yellow + ' does not exist'))
    }
    exec('rm -f ' + app.logPath + '/*', function (err) {
        if (err) return callback(err)
        callback(null, 'cleaned logs for ' + appname.yellow)
    })
}

api.getAppInfo = function (appname) {
    var info = getAppPaths(appname)
    info.config = globalConfig.apps[appname]
    if (!info.config) return
    info.script = info.workPath + '/' + (getAppMainScript(info.workPath) || globalConfig.defaultScript)
    info.port = info.config.port || sniffPort(info.script) || 'unknown port'
    return info
}

api.getConfig = function () {
    return globalConfig
}

// helpers

function restart (app, callback) {
    var msg = app.opts.name.yellow + ' restarted'
    if (app.status === 'stopped') {
        Satan.executeRemote('startId', { id: app.pm_id }, function (err) {
            if (err) return callback(err)
            callback(null, msg)
        })
    } else {
        try {
            process.kill(app.pid)
        } catch (err) {
            return callback(err)
        }
        return callback(null, msg)
    }
}

function getAppPaths (app) {
    return {
        name: app,
        repoPath    : globalConfig.root + '/repos/' + app + '.git',
        workPath    : globalConfig.root + '/apps/' + app,
        logPath     : globalConfig.root + '/logs/' + app
    }
}

function createAppRepo (info, done) {
    async.series([
        function (next) {
            // create repo directory
            fs.mkdir(info.repoPath, next)
        },
        function (next) {
            // init bare repo
            exec('git --git-dir ' + info.repoPath + ' --bare init', function (err) {
                next(err, 'created bare repo at ' + info.repoPath.yellow)
            })
        },
        function (next) {
            // create post-receive hook
            createHook(info, function (err) {
                next(err, 'created post-receive hook.')
            })
        },
        function (next) {
            // clone an empty working copy
            exec('git clone ' + info.repoPath + ' ' + info.workPath, function (err) {
                next(err, 'created empty working copy at ' + info.workPath.yellow)
            })
        }
    ], function (err, msgs) {
        msgs.shift()
        done(err, msgs)
    })
}

function createHook (info, done) {
    var hookPath = info.repoPath + '/hooks/post-receive'
    async.waterfall([
        function (next) {
            fs.readFile(__dirname + '/../hooks/post-receive', 'utf-8', next)
        },
        function (data, next) {
            data = data
                .replace(/\{\{pod_dir\}\}/g, globalConfig.root)
                .replace(/\{\{app\}\}/g, info.name)
            fs.writeFile(hookPath, data, next)
        },
        function (next) {
            fs.chmod(hookPath, '0777', next)
        }
    ], done)
}

function isRunning(appname, list) {
    if (!list || !list.length) return false
    for (var i = 0, j = list.length; i < j; i++) {
        if (list[i].opts.name === appname) {
            return true
        }
    }
}

function getAppMainScript (workPath) {
    var pkg = readJSON(workPath + '/package.json')
    if (pkg) return pkg.main
}

function readJSON (file) {
    if (!fs.existsSync(file)) {
        return null
    } else {
        return JSON.parse(fs.readFileSync(file, 'utf-8'))
    }
}

function sniffPort (script) {
    if (fs.existsSync(script)) {
        // sniff port
        var content = fs.readFileSync(script, 'utf-8'),
            portMatch = content.match(/\.listen\(\D*(\d\d\d\d\d?)\D*\)/)
        return portMatch ? portMatch[1] : null
    } else {
        return null
    }
}

function prepareConfig (appInfo) {

    var app = {
        name: appInfo.name,
        script: appInfo.script
    }

    for (var o in appInfo.config) {
        if (o !== 'port' && o !== 'nodeEnv') {
            app[o] = appInfo.config[o]
        }
    }

    app["pm_exec_path"]        = path.resolve(process.cwd(), app.script)

    if (app.fileOutput)
        app["pm_out_log_path"] = path.resolve(process.cwd(), app.fileOutput)
    else {
        app["pm_out_log_path"] = path.resolve(cst.DEFAULT_LOG_PATH, [app.name, '-out.log'].join(''))
        app.fileOutput         = app["pm_out_log_path"]
    }

    if (app.fileError)
        app["pm_err_log_path"] = path.resolve(process.cwd(), app.fileError)
    else {
        app["pm_err_log_path"] = path.resolve(cst.DEFAULT_LOG_PATH, [app.name, '-err.log'].join(''))
        app.fileError          = app["pm_err_log_path"]
    }

    if (app.pidFile)
        app["pm_pid_path"]     = path.resolve(process.cwd(), app.pidFile)
    else {
        app["pm_pid_path"]     = path.resolve(cst.DEFAULT_PID_PATH, [app.name, '.pid'].join(''))
        app.pidFile            = app["pm_pid_path"]
    }

    return app
}

// Initialization

function tryInit () {
    if (fs.readFileSync(globalConfigPath)) {
        globalConfig = readJSON(globalConfigPath)
        makeDirs()
        return api
    }
}

function initConfig (root) {
    globalConfig = {
        root: root,
        nodeEnv: 'development',
        defaultScript: 'app.js',
        editor: process.env.VISUAL || process.env.EDITOR || 'vi',
        apps: {}
    }
    fs.writeFileSync(globalConfigPath, JSON.stringify(globalConfig, null, 4))
    makeDirs()
    return api
}

function makeDirs() {
    if (!fs.existsSync(globalConfig.root)) {
        fs.mkdirSync(globalConfig.root)
    }
    ;['apps', 'repos', 'logs'].forEach(function (dir) {
        dir = globalConfig.root + '/' + dir
        if (!fs.existsSync(dir)) fs.mkdirSync(dir)
    })
}

// Expose stuff
// TODO auto create config if not found
// prompt for root dir if cli
// auto pick root dir if api
module.exports = {

    tryInit: tryInit,

    init: function (root) {
        return tryInit() || initConfig(root || (process.env.HOME + '/.pod'))
    },

    initTest: function (config) {
        testing = true
        globalConfig = config
        globalConfigPath = config.root + '/.podrc'
        return api
    },

}