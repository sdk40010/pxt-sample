var pxt;
(function (pxt) {
    var editor;
    (function (editor) {
        let SimState;
        (function (SimState) {
            SimState[SimState["Stopped"] = 0] = "Stopped";
            // waiting to be started
            SimState[SimState["Pending"] = 1] = "Pending";
            SimState[SimState["Starting"] = 2] = "Starting";
            SimState[SimState["Running"] = 3] = "Running";
        })(SimState = editor.SimState || (editor.SimState = {}));
        function isBlocks(f) {
            return pxt.U.endsWith(f.name, ".blocks");
        }
        editor.isBlocks = isBlocks;
        let ErrorListState;
        (function (ErrorListState) {
            ErrorListState["HeaderOnly"] = "errorListHeader";
            ErrorListState["Expanded"] = "errorListExpanded";
        })(ErrorListState = editor.ErrorListState || (editor.ErrorListState = {}));
        let FilterState;
        (function (FilterState) {
            FilterState[FilterState["Hidden"] = 0] = "Hidden";
            FilterState[FilterState["Visible"] = 1] = "Visible";
            FilterState[FilterState["Disabled"] = 2] = "Disabled";
        })(FilterState = editor.FilterState || (editor.FilterState = {}));
        editor.initExtensionsAsync = opts => Promise.resolve({});
        editor.initFieldExtensionsAsync = opts => Promise.resolve({});
        editor.HELP_IMAGE_URI = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjYiIGhlaWdodD0iMjYiIHZpZXdCb3g9IjAgMCAyNiAyNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTMiIGN5PSIxMyIgcj0iMTMiIGZpbGw9IndoaXRlIi8+CjxwYXRoIGQ9Ik0xNy45NTIgOS4xODQwMkMxNy45NTIgMTAuMjU2IDE3LjgxNiAxMS4wNzIgMTcuNTQ0IDExLjYzMkMxNy4yODggMTIuMTkyIDE2Ljc1MiAxMi43OTIgMTUuOTM2IDEzLjQzMkMxNS4xMiAxNC4wNzIgMTQuNTc2IDE0LjU4NCAxNC4zMDQgMTQuOTY4QzE0LjA0OCAxNS4zMzYgMTMuOTIgMTUuNzM2IDEzLjkyIDE2LjE2OFYxNi45NkgxMS44MDhDMTEuNDI0IDE2LjQ2NCAxMS4yMzIgMTUuODQgMTEuMjMyIDE1LjA4OEMxMS4yMzIgMTQuNjg4IDExLjM4NCAxNC4yODggMTEuNjg4IDEzLjg4OEMxMS45OTIgMTMuNDg4IDEyLjUzNiAxMi45NjggMTMuMzIgMTIuMzI4QzE0LjEwNCAxMS42NzIgMTQuNjI0IDExLjE2OCAxNC44OCAxMC44MTZDMTUuMTM2IDEwLjQ0OCAxNS4yNjQgOS45NjgwMiAxNS4yNjQgOS4zNzYwMkMxNS4yNjQgOC4yMDgwMiAxNC40MTYgNy42MjQwMiAxMi43MiA3LjYyNDAyQzExLjc2IDcuNjI0MDIgMTAuNzUyIDcuNzM2MDIgOS42OTYgNy45NjAwMkw5LjE0NCA4LjA4MDAyTDkgNi4wODgwMkMxMC40ODggNS41NjAwMiAxMS44NCA1LjI5NjAyIDEzLjA1NiA1LjI5NjAyQzE0LjczNiA1LjI5NjAyIDE1Ljk2OCA1LjYwODAyIDE2Ljc1MiA2LjIzMjAyQzE3LjU1MiA2Ljg0MDAyIDE3Ljk1MiA3LjgyNDAyIDE3Ljk1MiA5LjE4NDAyWk0xMS40IDIyVjE4LjY0SDE0LjE4NFYyMkgxMS40WiIgZmlsbD0iIzU5NUU3NCIvPgo8L3N2Zz4K';
        let _initEditorExtensionsPromise;
        function initEditorExtensionsAsync() {
            if (!_initEditorExtensionsPromise) {
                _initEditorExtensionsPromise = Promise.resolve();
                if (pxt.appTarget && pxt.appTarget.appTheme && pxt.appTarget.appTheme.extendFieldEditors) {
                    const opts = {};
                    _initEditorExtensionsPromise = _initEditorExtensionsPromise
                        .then(() => pxt.BrowserUtils.loadBlocklyAsync())
                        .then(() => pxt.BrowserUtils.loadScriptAsync("fieldeditors.js"))
                        .then(() => pxt.editor.initFieldExtensionsAsync(opts))
                        .then(res => {
                        if (res.fieldEditors)
                            res.fieldEditors.forEach(fi => {
                                pxt.blocks.registerFieldEditor(fi.selector, fi.editor, fi.validator);
                            });
                    });
                }
            }
            return _initEditorExtensionsPromise;
        }
        editor.initEditorExtensionsAsync = initEditorExtensionsAsync;
    })(editor = pxt.editor || (pxt.editor = {}));
})(pxt || (pxt = {}));
var pxt;
(function (pxt) {
    var editor;
    (function (editor_1) {
        const pendingRequests = {};
        /**
         * Binds incoming window messages to the project view.
         * Requires the "allowParentController" flag in the pxtarget.json/appTheme object.
         *
         * When the project view receives a request (EditorMessageRequest),
         * it starts the command and returns the result upon completion.
         * The response (EditorMessageResponse) contains the request id and result.
         * Some commands may be async, use the ``id`` field to correlate to the original request.
         */
        function bindEditorMessages(getEditorAsync) {
            const allowEditorMessages = (pxt.appTarget.appTheme.allowParentController || pxt.shell.isControllerMode())
                && pxt.BrowserUtils.isIFrame();
            const allowExtensionMessages = pxt.appTarget.appTheme.allowPackageExtensions;
            const allowSimTelemetry = pxt.appTarget.appTheme.allowSimulatorTelemetry;
            if (!allowEditorMessages && !allowExtensionMessages && !allowSimTelemetry)
                return;
            window.addEventListener("message", (msg) => {
                const data = msg.data;
                if (!data || !/^pxt(host|editor|pkgext|sim)$/.test(data.type))
                    return false;
                if (data.type === "pxtpkgext" && allowExtensionMessages) {
                    // Messages sent to the editor iframe from a child iframe containing an extension
                    getEditorAsync().then(projectView => {
                        projectView.handleExtensionRequest(data);
                    });
                }
                else if (data.type === "pxtsim" && allowSimTelemetry) {
                    const event = data;
                    if (event.action === "event") {
                        if (event.category || event.message) {
                            pxt.reportError(event.category, event.message, event.data);
                        }
                        else {
                            pxt.tickEvent(event.tick, event.data);
                        }
                    }
                }
                else if (allowEditorMessages) {
                    // Messages sent to the editor from the parent frame
                    let p = Promise.resolve();
                    let resp = undefined;
                    if (data.type == "pxthost") { // response from the host
                        const req = pendingRequests[data.id];
                        if (!req) {
                            pxt.debug(`pxthost: unknown request ${data.id}`);
                        }
                        else {
                            p = p.then(() => req.resolve(data));
                        }
                    }
                    else if (data.type == "pxteditor") { // request from the editor
                        p = p.then(() => {
                            return getEditorAsync().then(projectView => {
                                const req = data;
                                pxt.debug(`pxteditor: ${req.action}`);
                                switch (req.action.toLowerCase()) {
                                    case "switchjavascript": return Promise.resolve().then(() => projectView.openJavaScript());
                                    case "switchpython": return Promise.resolve().then(() => projectView.openPython());
                                    case "switchblocks": return Promise.resolve().then(() => projectView.openBlocks());
                                    case "startsimulator": return Promise.resolve().then(() => projectView.startSimulator());
                                    case "restartsimulator": return Promise.resolve().then(() => projectView.restartSimulator());
                                    case "hidesimulator": return Promise.resolve().then(() => projectView.collapseSimulator());
                                    case "showsimulator": return Promise.resolve().then(() => projectView.expandSimulator());
                                    case "closeflyout": return Promise.resolve().then(() => projectView.closeFlyout());
                                    case "unloadproject": return Promise.resolve().then(() => projectView.unloadProjectAsync());
                                    case "saveproject": return projectView.saveProjectAsync();
                                    case "redo": return Promise.resolve()
                                        .then(() => {
                                        const editor = projectView.editor;
                                        if (editor && editor.hasRedo())
                                            editor.redo();
                                    });
                                    case "undo": return Promise.resolve()
                                        .then(() => {
                                        const editor = projectView.editor;
                                        if (editor && editor.hasUndo())
                                            editor.undo();
                                    });
                                    case "setscale": {
                                        const zoommsg = data;
                                        return Promise.resolve()
                                            .then(() => projectView.editor.setScale(zoommsg.scale));
                                    }
                                    case "stopsimulator": {
                                        const stop = data;
                                        return Promise.resolve()
                                            .then(() => projectView.stopSimulator(stop.unload));
                                    }
                                    case "newproject": {
                                        const create = data;
                                        return Promise.resolve()
                                            .then(() => projectView.newProject(create.options));
                                    }
                                    case "importproject": {
                                        const load = data;
                                        return Promise.resolve()
                                            .then(() => projectView.importProjectAsync(load.project, {
                                            filters: load.filters,
                                            searchBar: load.searchBar
                                        }));
                                    }
                                    case "openheader": {
                                        const open = data;
                                        return projectView.openProjectByHeaderIdAsync(open.headerId);
                                    }
                                    case "startactivity": {
                                        const msg = data;
                                        let tutorialPath = msg.path;
                                        let editorProjectName = undefined;
                                        if (/^([jt]s|py|blocks?):/i.test(tutorialPath)) {
                                            if (/^py:/i.test(tutorialPath))
                                                editorProjectName = pxt.PYTHON_PROJECT_NAME;
                                            else if (/^[jt]s:/i.test(tutorialPath))
                                                editorProjectName = pxt.JAVASCRIPT_PROJECT_NAME;
                                            else
                                                editorProjectName = pxt.BLOCKS_PROJECT_NAME;
                                            tutorialPath = tutorialPath.substr(tutorialPath.indexOf(':') + 1);
                                        }
                                        return Promise.resolve()
                                            .then(() => projectView.startActivity({
                                            activity: msg.activityType,
                                            path: tutorialPath,
                                            title: msg.title,
                                            editor: editorProjectName,
                                            previousProjectHeaderId: msg.previousProjectHeaderId,
                                            carryoverPreviousCode: msg.carryoverPreviousCode
                                        }));
                                    }
                                    case "importtutorial": {
                                        const load = data;
                                        return Promise.resolve()
                                            .then(() => projectView.importTutorialAsync(load.markdown));
                                    }
                                    case "proxytosim": {
                                        const simmsg = data;
                                        return Promise.resolve()
                                            .then(() => projectView.proxySimulatorMessage(simmsg.content));
                                    }
                                    case "renderblocks": {
                                        const rendermsg = data;
                                        return Promise.resolve()
                                            .then(() => projectView.renderBlocksAsync(rendermsg))
                                            .then(r => {
                                            return r.xml.then((svg) => {
                                                resp = svg.xml;
                                            });
                                        });
                                    }
                                    case "renderpython": {
                                        const rendermsg = data;
                                        return Promise.resolve()
                                            .then(() => projectView.renderPythonAsync(rendermsg))
                                            .then(r => {
                                            resp = r.python;
                                        });
                                    }
                                    case "toggletrace": {
                                        const togglemsg = data;
                                        return Promise.resolve()
                                            .then(() => projectView.toggleTrace(togglemsg.intervalSpeed));
                                    }
                                    case "settracestate": {
                                        const trcmsg = data;
                                        return Promise.resolve()
                                            .then(() => projectView.setTrace(trcmsg.enabled, trcmsg.intervalSpeed));
                                    }
                                    case "setsimulatorfullscreen": {
                                        const fsmsg = data;
                                        return Promise.resolve()
                                            .then(() => projectView.setSimulatorFullScreen(fsmsg.enabled));
                                    }
                                    case "togglehighcontrast": {
                                        return Promise.resolve()
                                            .then(() => projectView.toggleHighContrast());
                                    }
                                    case "sethighcontrast": {
                                        const hcmsg = data;
                                        return Promise.resolve()
                                            .then(() => projectView.setHighContrast(hcmsg.on));
                                    }
                                    case "togglegreenscreen": {
                                        return Promise.resolve()
                                            .then(() => projectView.toggleGreenScreen());
                                    }
                                    case "print": {
                                        return Promise.resolve()
                                            .then(() => projectView.printCode());
                                    }
                                    case "pair": {
                                        return projectView.pairAsync();
                                    }
                                    case "info": {
                                        return Promise.resolve()
                                            .then(() => {
                                            resp = {
                                                versions: pxt.appTarget.versions,
                                                locale: ts.pxtc.Util.userLanguage(),
                                                availableLocales: pxt.appTarget.appTheme.availableLocales
                                            };
                                        });
                                    }
                                    case "shareproject": {
                                        const msg = data;
                                        return projectView.anonymousPublishHeaderByIdAsync(msg.headerId)
                                            .then(scriptInfo => {
                                            resp = scriptInfo;
                                        });
                                    }
                                    case "savelocalprojectstocloud": {
                                        const msg = data;
                                        return projectView.saveLocalProjectsToCloudAsync(msg.headerIds)
                                            .then(guidMap => {
                                            resp = {
                                                headerIdMap: guidMap
                                            };
                                        });
                                    }
                                    case "requestprojectcloudstatus": {
                                        // Responses are sent as separate "projectcloudstatus" messages.
                                        const msg = data;
                                        return projectView.requestProjectCloudStatus(msg.headerIds);
                                    }
                                    case "convertcloudprojectstolocal": {
                                        const msg = data;
                                        return projectView.convertCloudProjectsToLocal(msg.userId);
                                    }
                                    case "setlanguagerestriction": {
                                        const msg = data;
                                        if (msg.restriction === "no-blocks") {
                                            console.warn("no-blocks language restriction is not supported");
                                            throw new Error("no-blocks language restriction is not supported");
                                        }
                                        return projectView.setLanguageRestrictionAsync(msg.restriction);
                                    }
                                }
                                return Promise.resolve();
                            });
                        });
                    }
                    p.then(() => sendResponse(data, resp, true, undefined), (err) => sendResponse(data, resp, false, err));
                }
                return true;
            }, false);
        }
        editor_1.bindEditorMessages = bindEditorMessages;
        /**
         * Sends analytics messages upstream to container if any
         */
        function enableControllerAnalytics() {
            if (!pxt.appTarget.appTheme.allowParentController || !pxt.BrowserUtils.isIFrame())
                return;
            const te = pxt.tickEvent;
            pxt.tickEvent = function (id, data) {
                if (te)
                    te(id, data);
                postHostMessageAsync({
                    type: 'pxthost',
                    action: 'event',
                    tick: id,
                    response: false,
                    data
                });
            };
            const rexp = pxt.reportException;
            pxt.reportException = function (err, data) {
                if (rexp)
                    rexp(err, data);
                try {
                    postHostMessageAsync({
                        type: 'pxthost',
                        action: 'event',
                        tick: 'error',
                        message: err.message,
                        response: false,
                        data
                    });
                }
                catch (e) {
                }
            };
            const re = pxt.reportError;
            pxt.reportError = function (cat, msg, data) {
                if (re)
                    re(cat, msg, data);
                postHostMessageAsync({
                    type: 'pxthost',
                    action: 'event',
                    tick: 'error',
                    category: cat,
                    message: msg,
                    data
                });
            };
        }
        editor_1.enableControllerAnalytics = enableControllerAnalytics;
        function sendResponse(request, resp, success, error) {
            if (request.response) {
                window.parent.postMessage({
                    type: request.type,
                    id: request.id,
                    resp,
                    success,
                    error
                }, "*");
            }
        }
        /**
         * Determines if host messages should be posted
         */
        function shouldPostHostMessages() {
            return pxt.appTarget.appTheme.allowParentController && pxt.BrowserUtils.isIFrame();
        }
        editor_1.shouldPostHostMessages = shouldPostHostMessages;
        /**
         * Posts a message from the editor to the host
         */
        function postHostMessageAsync(msg) {
            return new Promise((resolve, reject) => {
                const env = pxt.Util.clone(msg);
                env.id = ts.pxtc.Util.guidGen();
                if (msg.response)
                    pendingRequests[env.id] = { resolve, reject };
                window.parent.postMessage(env, "*");
                if (!msg.response)
                    resolve(undefined);
            });
        }
        editor_1.postHostMessageAsync = postHostMessageAsync;
    })(editor = pxt.editor || (pxt.editor = {}));
})(pxt || (pxt = {}));
var pxt;
(function (pxt) {
    var editor;
    (function (editor) {
        var experiments;
        (function (experiments_1) {
            function key(experiment) {
                const id = (typeof experiment === "object") ? experiment.id : experiment;
                return `experiments-${id}`;
            }
            function syncTheme() {
                const theme = pxt.savedAppTheme();
                const r = {};
                const experiments = all();
                experiments.forEach(experiment => {
                    const enabled = isEnabled(experiment);
                    theme[experiment.id] = !!enabled;
                    if (enabled)
                        r[experiment.id] = enabled ? 1 : 0;
                });
                if (experiments.length && Object.keys(r).length) {
                    pxt.tickEvent("experiments.loaded", r);
                    pxt.reloadAppTargetVariant();
                }
                return pxt.appTarget.appTheme;
            }
            experiments_1.syncTheme = syncTheme;
            function all() {
                const ids = pxt.appTarget.appTheme.experiments;
                if (!ids)
                    return [];
                return [
                    {
                        id: "print",
                        name: lf("Print Code"),
                        description: lf("Print the code from the current project"),
                        feedbackUrl: "https://github.com/microsoft/pxt/issues/4740"
                    },
                    {
                        id: "greenScreen",
                        name: lf("Green screen"),
                        description: lf("Display a webcam video stream or a green background behind the code."),
                        feedbackUrl: "https://github.com/microsoft/pxt/issues/4738"
                    },
                    {
                        id: "allowPackageExtensions",
                        name: lf("Editor Extensions"),
                        description: lf("Allow Extensions to add buttons in the editor."),
                        feedbackUrl: "https://github.com/microsoft/pxt/issues/4741"
                    },
                    {
                        id: "instructions",
                        name: lf("Wiring Instructions"),
                        description: lf("Generate step-by-step assembly instructions for breadboard wiring."),
                        feedbackUrl: "https://github.com/microsoft/pxt/issues/4739"
                    },
                    {
                        id: "debugger",
                        name: lf("Debugger"),
                        description: lf("Step through code and inspect variables in the debugger"),
                        feedbackUrl: "https://github.com/microsoft/pxt/issues/4729"
                    },
                    {
                        id: "bluetoothUartConsole",
                        name: "Bluetooth Console",
                        description: lf("Receives UART message through Web Bluetooth"),
                        feedbackUrl: "https://github.com/microsoft/pxt/issues/4796"
                    },
                    {
                        id: "bluetoothPartialFlashing",
                        name: "Bluetooth Download",
                        description: lf("Download code via Web Bluetooth"),
                        feedbackUrl: "https://github.com/microsoft/pxt/issues/4807"
                    },
                    {
                        id: "simScreenshot",
                        name: lf("Simulator Screenshots"),
                        description: lf("Download screenshots of the simulator"),
                        feedbackUrl: "https://github.com/microsoft/pxt/issues/5232"
                    },
                    {
                        id: "python",
                        name: lf("Static Python"),
                        description: lf("Use Static Python to code your device"),
                        feedbackUrl: "https://github.com/microsoft/pxt/issues/5390"
                    },
                    {
                        id: "simGif",
                        name: lf("Simulator Gifs"),
                        description: lf("Download gifs of the simulator"),
                        feedbackUrl: "https://github.com/microsoft/pxt/issues/5297"
                    },
                    {
                        id: "qrCode",
                        name: lf("Shared QR Code"),
                        description: lf("Generate a QR Code form the shared project url"),
                        feedbackUrl: "https://github.com/microsoft/pxt/issues/5456"
                    },
                    {
                        id: "importExtensionFiles",
                        name: lf("Import Extension Files"),
                        description: lf("Import Extensions from compiled project files")
                    },
                    {
                        id: "debugExtensionCode",
                        name: lf("Debug Extension Code"),
                        description: lf("Use the JavaScript debugger to debug extension code")
                    },
                    {
                        id: "snippetBuilder",
                        name: lf("Snippet Builder"),
                        description: lf("Try out the new snippet dialogs.")
                    },
                    {
                        id: "experimentalHw",
                        name: lf("Experimental Hardware"),
                        description: lf("Enable support for hardware marked 'experimental' in the hardware seletion dialog")
                    },
                    {
                        id: "checkForHwVariantWebUSB",
                        name: lf("Detect Hardware with WebUSB"),
                        description: lf("When compiling, use WebUSB to detect hardware configuration.")
                    },
                    {
                        id: "githubEditor",
                        name: lf("GitHub editor"),
                        description: lf("Review, commit and push to GitHub."),
                        feedbackUrl: "https://github.com/microsoft/pxt/issues/6419",
                        enableOnline: true,
                    },
                    {
                        id: "githubCompiledJs",
                        name: lf("GitHub Pages JavaScript"),
                        description: lf("Commit compiled javascript when creating a release"),
                        enableOnline: true,
                    },
                    {
                        id: "blocksCollapsing",
                        name: lf("Collapse blocks"),
                        description: lf("Collapse and expand functions or event blocks")
                    },
                    {
                        id: "tutorialBlocksDiff",
                        name: lf("Tutorial Block Diffs"),
                        description: lf("Automatially render blocks diff in tutorials")
                    },
                    {
                        id: "openProjectNewTab",
                        name: lf("Open in New Tab"),
                        description: lf("Open an editor in a new tab.")
                    },
                    {
                        id: "openProjectNewDependentTab",
                        name: lf("Open in New Connected Tab"),
                        description: lf("Open connected editors in different browser tabs.")
                    },
                    {
                        id: "accessibleBlocks",
                        name: lf("Accessible Blocks"),
                        description: lf("Use the WASD keys to move and modify blocks."),
                        feedbackUrl: "https://github.com/microsoft/pxt/issues/6850"
                    },
                    {
                        id: "errorList",
                        name: lf("Error List"),
                        description: lf("Show an error list panel for JavaScript and Python.")
                    },
                    {
                        id: "blocksErrorList",
                        name: lf("Blocks Error List"),
                        description: lf("Show an error list panel for Blocks")
                    },
                ].filter(experiment => ids.indexOf(experiment.id) > -1 && !(pxt.BrowserUtils.isPxtElectron() && experiment.enableOnline));
            }
            experiments_1.all = all;
            function clear() {
                all().forEach(experiment => pxt.storage.removeLocal(key(experiment)));
                syncTheme();
            }
            experiments_1.clear = clear;
            function someEnabled() {
                return all().some(experiment => isEnabled(experiment));
            }
            experiments_1.someEnabled = someEnabled;
            function isEnabled(experiment) {
                return !!pxt.storage.getLocal(key(experiment));
            }
            experiments_1.isEnabled = isEnabled;
            function toggle(experiment) {
                setState(experiment, !isEnabled(experiment));
            }
            experiments_1.toggle = toggle;
            function state() {
                const r = {};
                all().forEach(experiment => r[experiment.id] = isEnabled(experiment));
                return JSON.stringify(r);
            }
            experiments_1.state = state;
            function setState(experiment, enabled) {
                if (enabled == isEnabled(experiment))
                    return; // no changes
                if (enabled)
                    pxt.storage.setLocal(key(experiment), "1");
                else
                    pxt.storage.removeLocal(key(experiment));
                // sync theme
                syncTheme();
            }
            experiments_1.setState = setState;
        })(experiments = editor.experiments || (editor.experiments = {}));
    })(editor = pxt.editor || (pxt.editor = {}));
})(pxt || (pxt = {}));
/// <reference path="../localtypings/monaco.d.ts" />
/// <reference path="../built/pxtlib.d.ts"/>
/// <reference path="../built/pxtblocks.d.ts"/>
var pxt;
(function (pxt) {
    var vs;
    (function (vs) {
        function syncModels(mainPkg, libs, currFile, readOnly) {
            if (readOnly)
                return;
            let extraLibs = monaco.languages.typescript.typescriptDefaults.getExtraLibs();
            let modelMap = {};
            mainPkg.sortedDeps().forEach(pkg => {
                pkg.getFiles().forEach(f => {
                    let fp = pkg.id + "/" + f;
                    let proto = "pkg:" + fp;
                    if (/\.(ts)$/.test(f) && fp != currFile) {
                        if (!monaco.languages.typescript.typescriptDefaults.getExtraLibs()[fp]) {
                            // inserting a space creates syntax errors in Python
                            let content = pkg.readFile(f) || "\n";
                            libs[fp] = monaco.languages.typescript.typescriptDefaults.addExtraLib(content, fp);
                        }
                        modelMap[fp] = "1";
                    }
                });
            });
            // dispose of any extra libraries, the typescript worker will be killed as a result of this
            Object.keys(extraLibs)
                .filter(lib => /\.(ts)$/.test(lib) && !modelMap[lib])
                .forEach(lib => {
                libs[lib].dispose();
            });
        }
        vs.syncModels = syncModels;
        function initMonacoAsync(element) {
            return new Promise((resolve, reject) => {
                if (typeof (window.monaco) === 'object') {
                    // monaco is already loaded
                    resolve(createEditor(element));
                    return;
                }
                let monacoPaths = window.MonacoPaths;
                let onGotAmdLoader = () => {
                    let req = window.require;
                    req.config({ paths: monacoPaths });
                    // Load monaco
                    req(['vs/editor/editor.main'], () => {
                        setupMonaco();
                        resolve(createEditor(element));
                    });
                };
                // Load AMD loader if necessary
                if (!window.require) {
                    let loaderScript = document.createElement('script');
                    loaderScript.type = 'text/javascript';
                    loaderScript.src = monacoPaths['vs/loader'];
                    loaderScript.addEventListener('load', onGotAmdLoader);
                    document.body.appendChild(loaderScript);
                }
                else {
                    onGotAmdLoader();
                }
            });
        }
        vs.initMonacoAsync = initMonacoAsync;
        function setupMonaco() {
            initAsmMonarchLanguage();
            initTypeScriptLanguageDefinition();
        }
        function createEditor(element) {
            const inverted = pxt.appTarget.appTheme.invertedMonaco;
            const hasFieldEditors = !!(pxt.appTarget.appTheme.monacoFieldEditors && pxt.appTarget.appTheme.monacoFieldEditors.length);
            const isAndroid = pxt.BrowserUtils.isAndroid();
            let editor = monaco.editor.create(element, {
                model: null,
                ariaLabel: pxt.Util.lf("JavaScript editor"),
                fontFamily: "'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', 'source-code-pro', 'monospace'",
                scrollBeyondLastLine: true,
                language: "typescript",
                mouseWheelZoom: false,
                wordBasedSuggestions: true,
                lineNumbersMinChars: 3,
                formatOnPaste: true,
                folding: hasFieldEditors,
                glyphMargin: hasFieldEditors || pxt.appTarget.appTheme.debugger,
                minimap: {
                    enabled: false
                },
                fixedOverflowWidgets: true,
                autoIndent: "full",
                useTabStops: true,
                dragAndDrop: true,
                matchBrackets: "always",
                occurrencesHighlight: false,
                quickSuggestionsDelay: 200,
                theme: inverted ? 'vs-dark' : 'vs',
                renderIndentGuides: true,
                accessibilityHelpUrl: "",
                // disable completions on android
                quickSuggestions: {
                    "other": !isAndroid,
                    "comments": !isAndroid,
                    "strings": !isAndroid
                },
                acceptSuggestionOnCommitCharacter: !isAndroid,
                acceptSuggestionOnEnter: !isAndroid ? "on" : "off",
                accessibilitySupport: !isAndroid ? "on" : "off"
            });
            editor.layout();
            return editor;
        }
        vs.createEditor = createEditor;
        function initAsmMonarchLanguage() {
            monaco.languages.register({ id: 'asm', extensions: ['.asm'] });
            monaco.languages.setMonarchTokensProvider('asm', {
                // Set defaultToken to invalid to see what you do not tokenize yet
                // defaultToken: 'invalid',
                tokenPostfix: '',
                //Extracted from http://infocenter.arm.com/help/topic/com.arm.doc.qrc0006e/QRC0006_UAL16.pdf
                //Should be a superset of the instructions emitted
                keywords: [
                    'movs', 'mov', 'adds', 'add', 'adcs', 'adr', 'subs', 'sbcs', 'sub', 'rsbs',
                    'muls', 'cmp', 'cmn', 'ands', 'eors', 'orrs', 'bics', 'mvns', 'tst', 'lsls',
                    'lsrs', 'asrs', 'rors', 'ldr', 'ldrh', 'ldrb', 'ldrsh', 'ldrsb', 'ldm',
                    'str', 'strh', 'strb', 'stm', 'push', 'pop', 'cbz', 'cbnz', 'b', 'bl', 'bx', 'blx',
                    'sxth', 'sxtb', 'uxth', 'uxtb', 'rev', 'rev16', 'revsh', 'svc', 'cpsid', 'cpsie',
                    'setend', 'bkpt', 'nop', 'sev', 'wfe', 'wfi', 'yield',
                    'beq', 'bne', 'bcs', 'bhs', 'bcc', 'blo', 'bmi', 'bpl', 'bvs', 'bvc', 'bhi', 'bls',
                    'bge', 'blt', 'bgt', 'ble', 'bal',
                    //Registers
                    'r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
                    'pc', 'sp', 'lr'
                ],
                typeKeywords: [
                    '.startaddr', '.hex', '.short', '.space', '.section', '.string', '.byte'
                ],
                operators: [],
                // Not all of these are valid in ARM Assembly
                symbols: /[:\*]+/,
                // C# style strings
                escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
                // The main tokenizer for our languages
                tokenizer: {
                    root: [
                        // identifiers and keywords
                        [/(\.)?[a-z_$\.][\w$]*/, {
                                cases: {
                                    '@typeKeywords': 'keyword',
                                    '@keywords': 'keyword',
                                    '@default': 'identifier'
                                }
                            }],
                        // whitespace
                        { include: '@whitespace' },
                        // delimiters and operators
                        [/[{}()\[\]]/, '@brackets'],
                        [/[<>](?!@symbols)/, '@brackets'],
                        [/@symbols/, {
                                cases: {
                                    '@operators': 'operator',
                                    '@default': ''
                                }
                            }],
                        // @ annotations.
                        [/@\s*[a-zA-Z_\$][\w\$]*/, { token: 'annotation' }],
                        // numbers
                        //[/\d*\.\d+([eE][\-+]?\d+)?/, 'number.float'],
                        [/(#|(0[xX]))?[0-9a-fA-F]+/, 'number'],
                        // delimiter: after number because of .\d floats
                        [/[;,.]/, 'delimiter'],
                        // strings
                        [/"([^"\\]|\\.)*$/, 'string.invalid'],
                        [/"/, { token: 'string.quote', bracket: '@open', next: '@string' }],
                        // characters
                        [/'[^\\']'/, 'string'],
                        [/(')(@escapes)(')/, ['string', 'string.escape', 'string']],
                        [/'/, 'string.invalid']
                    ],
                    comment: [],
                    string: [
                        [/[^\\"]+/, 'string'],
                        [/@escapes/, 'string.escape'],
                        [/\\./, 'string.escape.invalid'],
                        [/"/, { token: 'string.quote', bracket: '@close', next: '@pop' }]
                    ],
                    whitespace: [
                        [/[ \t\r\n]+/, 'white'],
                        [/\/\*/, 'comment', '@comment'],
                        [/;.*$/, 'comment'],
                    ],
                }
            });
        }
        function initTypeScriptLanguageDefinition() {
            if (!monaco.languages.typescript) {
                return;
            }
            // validation settings
            monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
                noSyntaxValidation: true,
                noSemanticValidation: true
            });
            // Register our worker
            monaco.languages.typescript.typescriptDefaults.setWorkerOptions({
                customWorkerPath: pxt.webConfig.typeScriptWorkerJs
            });
            // compiler options
            monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
                allowUnreachableCode: true,
                noImplicitAny: true,
                allowJs: false,
                allowUnusedLabels: true,
                target: monaco.languages.typescript.ScriptTarget.ES5,
                outDir: "built",
                rootDir: ".",
                noLib: true,
                mouseWheelZoom: false
            });
        }
    })(vs = pxt.vs || (pxt.vs = {}));
})(pxt || (pxt = {}));
/// <reference path="../built/pxtlib.d.ts"/>
var pxt;
(function (pxt) {
    var workspace;
    (function (workspace) {
        function freshHeader(name, modTime) {
            let header = {
                target: pxt.appTarget.id,
                targetVersion: pxt.appTarget.versions.target,
                name: name,
                meta: {},
                editor: pxt.JAVASCRIPT_PROJECT_NAME,
                pubId: "",
                pubCurrent: false,
                _rev: null,
                id: pxt.U.guidGen(),
                recentUse: modTime,
                modificationTime: modTime,
                cloudUserId: null,
                cloudCurrent: false,
                cloudVersion: null,
                cloudLastSyncTime: 0,
                isDeleted: false,
            };
            return header;
        }
        workspace.freshHeader = freshHeader;
    })(workspace = pxt.workspace || (pxt.workspace = {}));
})(pxt || (pxt = {}));
/// <reference path="../../localtypings/monaco.d.ts" />
var pxt;
(function (pxt) {
    var editor;
    (function (editor) {
        const definitions = {};
        function registerMonacoFieldEditor(name, definition) {
            definitions[name] = definition;
        }
        editor.registerMonacoFieldEditor = registerMonacoFieldEditor;
        function getMonacoFieldEditor(name) {
            return definitions[name];
        }
        editor.getMonacoFieldEditor = getMonacoFieldEditor;
    })(editor = pxt.editor || (pxt.editor = {}));
})(pxt || (pxt = {}));
/// <reference path="./monacoFieldEditor.ts" />
var pxt;
(function (pxt) {
    var editor;
    (function (editor) {
        const fieldEditorId = "image-editor";
        class MonacoReactFieldEditor {
            getId() {
                return fieldEditorId;
            }
            showEditorAsync(fileType, editrange, host) {
                this.fileType = fileType;
                this.editrange = editrange;
                this.host = host;
                return this.initAsync().then(() => {
                    const value = this.textToValue(host.getText(editrange));
                    if (!value) {
                        return Promise.resolve(null);
                    }
                    this.fv = pxt.react.getFieldEditorView(this.getFieldEditorId(), value, this.getOptions());
                    this.fv.onHide(() => {
                        this.onClosed();
                    });
                    this.fv.show();
                    return new Promise((resolve, reject) => {
                        this.resolver = resolve;
                        this.rejecter = reject;
                    });
                });
            }
            onClosed() {
                if (this.resolver) {
                    this.resolver({
                        range: this.editrange,
                        replacement: this.resultToText(this.fv.getResult())
                    });
                    this.editrange = undefined;
                    this.resolver = undefined;
                    this.rejecter = undefined;
                }
            }
            dispose() {
                this.onClosed();
            }
            initAsync() {
                return Promise.resolve();
            }
            textToValue(text) {
                return null;
            }
            resultToText(result) {
                return result + "";
            }
            getFieldEditorId() {
                return "";
            }
            getOptions() {
                return null;
            }
        }
        editor.MonacoReactFieldEditor = MonacoReactFieldEditor;
    })(editor = pxt.editor || (pxt.editor = {}));
})(pxt || (pxt = {}));
/// <reference path="./monacoFieldEditor.ts" />
/// <reference path="./field_react.ts" />
var pxt;
(function (pxt) {
    var editor;
    (function (editor) {
        const fieldEditorId = "image-editor";
        class MonacoSpriteEditor extends editor.MonacoReactFieldEditor {
            textToValue(text) {
                this.isPython = text.indexOf("`") === -1;
                const match = pxt.parseAssetTSReference(text);
                if (match) {
                    const { type, name: matchedName } = match;
                    const name = matchedName.trim();
                    const project = pxt.react.getTilemapProject();
                    this.isAsset = true;
                    const asset = project.lookupAssetByName("image" /* Image */, name);
                    if (asset) {
                        return asset;
                    }
                    else {
                        const newAsset = project.createNewImage();
                        if (name && !project.isNameTaken("image" /* Image */, name) && pxt.validateAssetName(name)) {
                            newAsset.meta.displayName = name;
                        }
                        return newAsset;
                    }
                }
                return createFakeAsset(pxt.sprite.imageLiteralToBitmap(text));
            }
            resultToText(result) {
                var _a;
                if ((_a = result.meta) === null || _a === void 0 ? void 0 : _a.displayName) {
                    const project = pxt.react.getTilemapProject();
                    if (this.isAsset || project.lookupAsset(result.type, result.id)) {
                        result = project.updateAsset(result);
                    }
                    else {
                        result = project.createNewProjectImage(result.bitmap, result.meta.displayName);
                    }
                    this.isAsset = true;
                    return pxt.getTSReferenceForAsset(result, this.isPython);
                }
                return pxt.sprite.bitmapToImageLiteral(pxt.sprite.Bitmap.fromData(result.bitmap), this.isPython ? "python" : "typescript");
            }
            getFieldEditorId() {
                return "image-editor";
            }
            getOptions() {
                return {
                    initWidth: 16,
                    initHeight: 16,
                    blocksInfo: this.host.blocksInfo()
                };
            }
        }
        editor.MonacoSpriteEditor = MonacoSpriteEditor;
        function createFakeAsset(bitmap) {
            return {
                type: "image" /* Image */,
                id: "",
                internalID: 0,
                bitmap: bitmap.data(),
                meta: {},
                jresData: ""
            };
        }
        editor.spriteEditorDefinition = {
            id: fieldEditorId,
            foldMatches: true,
            glyphCssClass: "sprite-editor-glyph sprite-focus-hover",
            heightInPixels: 510,
            matcher: {
                // match both JS and python
                searchString: "(?:img|assets\\s*\\.\\s*image)\\s*(?:`|\\(\\s*\"\"\")(?:(?:[^(){}:\\[\\]\"';?/,+\\-=*&|^%!`~]|\\n)*)\\s*(?:`|\"\"\"\\s*\\))",
                isRegex: true,
                matchCase: true,
                matchWholeWord: false
            },
            proto: MonacoSpriteEditor
        };
        editor.registerMonacoFieldEditor(fieldEditorId, editor.spriteEditorDefinition);
    })(editor = pxt.editor || (pxt.editor = {}));
})(pxt || (pxt = {}));
/// <reference path="./monacoFieldEditor.ts" />
/// <reference path="./field_react.ts" />
var pxt;
(function (pxt) {
    var editor;
    (function (editor) {
        const fieldEditorId = "tilemap-editor";
        class MonacoTilemapEditor extends editor.MonacoReactFieldEditor {
            textToValue(text) {
                const tm = this.readTilemap(text);
                const project = pxt.react.getTilemapProject();
                pxt.sprite.addMissingTilemapTilesAndReferences(project, tm);
                return tm;
            }
            readTilemap(text) {
                const project = pxt.react.getTilemapProject();
                if (/^\s*tiles\s*\./.test(text)) {
                    this.isTilemapLiteral = false;
                    if (text) {
                        try {
                            const data = pxt.sprite.decodeTilemap(text, "typescript", project);
                            return createFakeAsset(data);
                        }
                        catch (e) {
                            // If the user is still typing, they might try to open the editor on an incomplete tilemap
                        }
                        return null;
                    }
                }
                this.isTilemapLiteral = true;
                // This matches the regex for the field editor, so it should always match
                const match = /^\s*(tilemap(?:8|16|32)?)\s*(?:`([^`]*)`)|(?:\(\s*"""([^"]*)"""\s*\))\s*$/.exec(text);
                const name = (match[2] || match[3] || "").trim();
                this.tilemapLiteral = match[1];
                let proj;
                let id;
                if (name) {
                    let id = ts.pxtc.escapeIdentifier(name);
                    proj = project.getTilemap(id);
                }
                if (!proj) {
                    let tileWidth = 16;
                    if (this.tilemapLiteral === "tilemap8") {
                        tileWidth = 8;
                    }
                    else if (this.tilemapLiteral === "tilemap32") {
                        tileWidth = 32;
                    }
                    const [name] = project.createNewTilemap(id, tileWidth, 16, 16);
                    proj = project.getTilemap(name);
                    id = name;
                }
                return proj;
            }
            resultToText(asset) {
                const project = pxt.react.getTilemapProject();
                project.pushUndo();
                pxt.sprite.updateTilemapReferencesFromResult(project, asset);
                if (this.isTilemapLiteral) {
                    project.updateAsset(asset);
                    return pxt.getTSReferenceForAsset(asset, this.fileType === "python");
                }
                else {
                    return pxt.sprite.encodeTilemap(asset.data, this.fileType === "typescript" ? "typescript" : "python");
                }
            }
            getFieldEditorId() {
                return "tilemap-editor";
            }
            getOptions() {
                return {
                    initWidth: 16,
                    initHeight: 16,
                    blocksInfo: this.host.blocksInfo()
                };
            }
            getCreateTilemapRange() {
                const start = this.editrange.getStartPosition();
                let current = this.editrange.getEndPosition();
                let range;
                let openParen = 1;
                while (true) {
                    range = new monaco.Range(current.lineNumber, current.column, current.lineNumber + 1, 0);
                    const line = this.host.getText(range);
                    for (let i = 0; i < line.length; i++) {
                        if (line.charAt(i) === "(") {
                            openParen++;
                        }
                        else if (line.charAt(i) === ")") {
                            openParen--;
                            if (openParen === 0) {
                                const end = new monaco.Position(current.lineNumber, current.column + i + 2);
                                return monaco.Range.fromPositions(start, end);
                            }
                        }
                    }
                    current = range.getEndPosition();
                    if (current.lineNumber > start.lineNumber + 20) {
                        return null;
                    }
                }
            }
        }
        editor.MonacoTilemapEditor = MonacoTilemapEditor;
        function createFakeAsset(data) {
            return {
                type: "tilemap" /* Tilemap */,
                id: "",
                internalID: 0,
                meta: {},
                data
            };
        }
        editor.tilemapEditorDefinition = {
            id: fieldEditorId,
            foldMatches: true,
            alwaysBuildOnClose: true,
            glyphCssClass: "sprite-focus-hover ms-Icon ms-Icon--Nav2DMapView",
            heightInPixels: 510,
            weight: 5,
            matcher: {
                // match both JS and python
                searchString: "(?:tilemap(?:8|16|32)?\\s*(?:`|\\(\"\"\")(?:[ a-zA-Z0-9_]|\\n)*\\s*(?:`|\"\"\"\\)))|(?:tiles\\s*\\.\\s*createTilemap\\s*\\([^\\)]+\\))",
                isRegex: true,
                matchCase: true,
                matchWholeWord: false
            },
            proto: MonacoTilemapEditor
        };
        editor.registerMonacoFieldEditor(fieldEditorId, editor.tilemapEditorDefinition);
    })(editor = pxt.editor || (pxt.editor = {}));
})(pxt || (pxt = {}));
