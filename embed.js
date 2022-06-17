(function() {
    if (window.ksRunnerInit) return;

    // This line gets patched up by the cloud
    var pxtConfig = {
    "relprefix": "/pxt-sample/",
    "verprefix": "",
    "workerjs": "/pxt-sample/worker.js",
    "monacoworkerjs": "/pxt-sample/monacoworker.js",
    "gifworkerjs": "/pxt-sample/gifjs/gif.worker.js",
    "serviceworkerjs": "/pxt-sample/serviceworker.js",
    "typeScriptWorkerJs": "/pxt-sample/tsworker.js",
    "pxtVersion": "7.5.46",
    "pxtRelId": "localDirRelId",
    "pxtCdnUrl": "/pxt-sample/",
    "commitCdnUrl": "/pxt-sample/",
    "blobCdnUrl": "/pxt-sample/",
    "cdnUrl": "/pxt-sample/",
    "targetVersion": "0.0.0",
    "targetRelId": "",
    "targetUrl": "",
    "targetId": "turtle",
    "simUrl": "/pxt-sample/simulator.html",
    "simserviceworkerUrl": "/pxt-sample/simulatorserviceworker.js",
    "simworkerconfigUrl": "/pxt-sample/workerConfig.js",
    "partsUrl": "/pxt-sample/siminstructions.html",
    "runUrl": "/pxt-sample/run.html",
    "docsUrl": "/pxt-sample/docs.html",
    "multiUrl": "/pxt-sample/multi.html",
    "asseteditorUrl": "/pxt-sample/asseteditor.html",
    "skillmapUrl": "/pxt-sample/skillmap.html",
    "authcodeUrl": "/pxt-sample/authcode.html",
    "isStatic": true
};

    var scripts = [
        "/pxt-sample/highlight.js/highlight.pack.js",
        "/pxt-sample/marked/marked.min.js",
    ]

    if (typeof jQuery == "undefined")
        scripts.unshift("/pxt-sample/jquery.js")
    if (typeof jQuery == "undefined" || !jQuery.prototype.sidebar)
        scripts.push("/pxt-sample/semantic.js")
    if (!window.pxtTargetBundle)
        scripts.push("/pxt-sample/target.js");
    scripts.push("/pxt-sample/pxtembed.js");

    var pxtCallbacks = []

    window.ksRunnerReady = function(f) {
        if (pxtCallbacks == null) f()
        else pxtCallbacks.push(f)
    }

    window.ksRunnerWhenLoaded = function() {
        pxt.docs.requireHighlightJs = function() { return hljs; }
        pxt.setupWebConfig(pxtConfig || window.pxtWebConfig)
        pxt.runner.initCallbacks = pxtCallbacks
        pxtCallbacks.push(function() {
            pxtCallbacks = null
        })
        pxt.runner.init();
    }

    scripts.forEach(function(src) {
        var script = document.createElement('script');
        script.src = src;
        script.async = false;
        document.head.appendChild(script);
    })

} ())
