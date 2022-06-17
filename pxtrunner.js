var pxt;
(function (pxt) {
    var runner;
    (function (runner) {
        /**
         * Starts the simulator and injects it into the provided container.
         * the simulator will attempt to establish a websocket connection
         * to the debugger's user interface on port 3234.
         *
         * @param container The container to inject the simulator into
         */
        function startDebuggerAsync(container) {
            const debugRunner = new DebugRunner(container);
            debugRunner.start();
        }
        runner.startDebuggerAsync = startDebuggerAsync;
        /**
         * Runner for the debugger that handles communication with the user
         * interface. Also talks to the server for anything to do with
         * the filesystem (like reading code)
         */
        class DebugRunner {
            constructor(container) {
                this.container = container;
                this.pkgLoaded = false;
                this.intervalRunning = false;
            }
            start() {
                this.initializeWebsocket();
                if (!this.intervalRunning) {
                    this.intervalRunning = true;
                    this.intervalId = setInterval(() => {
                        if (!this.ws) {
                            try {
                                this.initializeWebsocket();
                            }
                            catch (e) {
                                console.warn(`Connection to server failed, retrying in ${DebugRunner.RETRY_MS} ms`);
                            }
                        }
                    }, DebugRunner.RETRY_MS);
                }
                this.session = new pxsim.SimDebugSession(this.container);
                this.session.start(this);
            }
            initializeWebsocket() {
                if (!pxt.BrowserUtils.isLocalHost() || !pxt.Cloud.localToken)
                    return;
                pxt.debug('initializing debug pipe');
                this.ws = new WebSocket('ws://localhost:3234/' + pxt.Cloud.localToken + '/simdebug');
                this.ws.onopen = ev => {
                    pxt.debug('debug: socket opened');
                };
                this.ws.onclose = ev => {
                    pxt.debug('debug: socket closed');
                    if (this.closeListener) {
                        this.closeListener();
                    }
                    this.session.stopSimulator();
                    this.ws = undefined;
                };
                this.ws.onerror = ev => {
                    pxt.debug('debug: socket closed due to error');
                    if (this.errorListener) {
                        this.errorListener(ev.type);
                    }
                    this.session.stopSimulator();
                    this.ws = undefined;
                };
                this.ws.onmessage = ev => {
                    let message;
                    try {
                        message = JSON.parse(ev.data);
                    }
                    catch (e) {
                        pxt.debug('debug: could not parse message');
                    }
                    if (message) {
                        // FIXME: ideally, we should just open two websockets instead of adding to the
                        // debug protocol. One for the debugger, one for meta-information and file
                        // system requests
                        if (message.type === 'runner') {
                            this.handleRunnerMessage(message);
                        }
                        else {
                            // Intercept the launch configuration and notify the server-side debug runner
                            if (message.type === "request" && message.command === "launch") {
                                this.sendRunnerMessage("configure", {
                                    projectDir: message.arguments.projectDir
                                });
                            }
                            this.dataListener(message);
                        }
                    }
                };
            }
            send(msg) {
                this.ws.send(msg);
            }
            onData(cb) {
                this.dataListener = cb;
            }
            onError(cb) {
                this.errorListener = cb;
            }
            onClose(cb) {
                this.closeListener = cb;
            }
            close() {
                if (this.session) {
                    this.session.stopSimulator(true);
                }
                if (this.intervalRunning) {
                    clearInterval(this.intervalId);
                    this.intervalId = undefined;
                }
                if (this.ws) {
                    this.ws.close();
                }
            }
            handleRunnerMessage(msg) {
                switch (msg.subtype) {
                    case "ready":
                        this.sendRunnerMessage("ready");
                        break;
                    case "runcode":
                        this.runCode(msg);
                        break;
                }
            }
            runCode(msg) {
                const breakpoints = [];
                // The breakpoints are in the format returned by the compiler
                // and need to be converted to the format used by the DebugProtocol
                msg.breakpoints.forEach(bp => {
                    breakpoints.push([bp.id, {
                            verified: true,
                            line: bp.line,
                            column: bp.column,
                            endLine: bp.endLine,
                            endColumn: bp.endColumn,
                            source: {
                                path: bp.fileName
                            }
                        }]);
                });
                this.session.runCode(msg.code, msg.usedParts, msg.usedArguments, new pxsim.BreakpointMap(breakpoints), pxt.appTarget.simulator.boardDefinition);
            }
            sendRunnerMessage(subtype, msg = {}) {
                msg["subtype"] = subtype;
                msg["type"] = "runner";
                this.send(JSON.stringify(msg));
            }
        }
        DebugRunner.RETRY_MS = 2500;
        runner.DebugRunner = DebugRunner;
    })(runner = pxt.runner || (pxt.runner = {}));
})(pxt || (pxt = {}));
var pxt;
(function (pxt) {
    var runner;
    (function (runner) {
        const JS_ICON = "icon xicon js";
        const PY_ICON = "icon xicon python";
        const BLOCKS_ICON = "icon xicon blocks";
        function defaultClientRenderOptions() {
            const renderOptions = {
                blocksAspectRatio: window.innerHeight < window.innerWidth ? 1.62 : 1 / 1.62,
                snippetClass: 'lang-blocks',
                signatureClass: 'lang-sig',
                blocksClass: 'lang-block',
                blocksXmlClass: 'lang-blocksxml',
                diffBlocksXmlClass: 'lang-diffblocksxml',
                diffClass: 'lang-diff',
                diffStaticPythonClass: 'lang-diffspy',
                diffBlocksClass: 'lang-diffblocks',
                staticPythonClass: 'lang-spy',
                simulatorClass: 'lang-sim',
                linksClass: 'lang-cards',
                namespacesClass: 'lang-namespaces',
                apisClass: 'lang-apis',
                codeCardClass: 'lang-codecard',
                packageClass: 'lang-package',
                jresClass: 'lang-jres',
                assetJSONClass: 'lang-assetsjson',
                projectClass: 'lang-project',
                snippetReplaceParent: true,
                simulator: true,
                showEdit: true,
                hex: true,
                tutorial: false,
                showJavaScript: false,
                hexName: pxt.appTarget.id
            };
            return renderOptions;
        }
        runner.defaultClientRenderOptions = defaultClientRenderOptions;
        function highlight($js) {
            if (typeof hljs !== "undefined") {
                if ($js.hasClass("highlight")) {
                    hljs.highlightBlock($js[0]);
                }
                else {
                    $js.find('code.highlight').each(function (i, block) {
                        hljs.highlightBlock(block);
                    });
                }
                highlightLine($js);
            }
        }
        function highlightLine($js) {
            // apply line highlighting
            $js.find("span.hljs-comment:contains(@highlight)")
                .each((i, el) => {
                try {
                    highlightLineElement(el);
                }
                catch (e) {
                    pxt.reportException(e);
                }
            });
        }
        function highlightLineElement(el) {
            const $el = $(el);
            const span = document.createElement("span");
            span.className = "highlight-line";
            // find new line and split text node
            let next = el.nextSibling;
            if (!next || next.nodeType != Node.TEXT_NODE)
                return; // end of snippet?
            let text = next.textContent;
            let inewline = text.indexOf('\n');
            if (inewline < 0)
                return; // there should have been a new line here
            // split the next node
            next.textContent = text.substring(0, inewline + 1);
            $(document.createTextNode(text.substring(inewline + 1).replace(/^\s+/, ''))).insertAfter($(next));
            // process and highlight new line
            next = next.nextSibling;
            while (next) {
                let nextnext = next.nextSibling; // before we hoist it from the tree
                if (next.nodeType == Node.TEXT_NODE) {
                    text = next.textContent;
                    const inewline = text.indexOf('\n');
                    if (inewline < 0) {
                        span.appendChild(next);
                        next = nextnext;
                    }
                    else {
                        // we've hit the end of the line... split node in two
                        span.appendChild(document.createTextNode(text.substring(0, inewline)));
                        next.textContent = text.substring(inewline + 1);
                        break;
                    }
                }
                else {
                    span.appendChild(next);
                    next = nextnext;
                }
            }
            // insert back
            $(span).insertAfter($el);
            // remove line entry
            $el.remove();
        }
        function appendBlocks($parent, $svg) {
            $parent.append($(`<div class="ui content blocks"/>`).append($svg));
        }
        function appendJs($parent, $js, woptions) {
            $parent.append($(`<div class="ui content js"><div class="subheading"><i class="ui icon xicon js"></i>JavaScript</div></div>`).append($js));
            highlight($js);
        }
        function appendPy($parent, $py, woptions) {
            $parent.append($(`<div class="ui content py"><div class="subheading"><i class="ui icon xicon python"></i>Python</div></div>`).append($py));
            highlight($py);
        }
        function snippetBtn(label, icon) {
            const $btn = $(`<a class="item" role="button" tabindex="0"><i role="presentation" aria-hidden="true"></i><span class="ui desktop only"></span></a>`);
            $btn.attr("aria-label", label);
            $btn.attr("title", label);
            $btn.find('i').attr("class", icon);
            $btn.find('span').text(label);
            addFireClickOnEnter($btn);
            return $btn;
        }
        function addFireClickOnEnter(el) {
            el.keypress(e => {
                const charCode = (typeof e.which == "number") ? e.which : e.keyCode;
                if (charCode === 13 /* enter */ || charCode === 32 /* space */) {
                    e.preventDefault();
                    e.currentTarget.click();
                }
            });
        }
        function fillWithWidget(options, $container, $js, $py, $svg, decompileResult, woptions = {}) {
            let $h = $('<div class="ui bottom attached tabular icon small compact menu hideprint">'
                + ' <div class="right icon menu"></div></div>');
            let $c = $('<div class="ui top attached segment codewidget"></div>');
            let $menu = $h.find('.right.menu');
            const theme = pxt.appTarget.appTheme || {};
            if (woptions.showEdit && !theme.hideDocsEdit && decompileResult) { // edit button
                const $editBtn = snippetBtn(lf("Edit"), "edit icon");
                const { package: pkg, compileBlocks, compilePython } = decompileResult;
                const host = pkg.host();
                if ($svg && compileBlocks) {
                    pkg.setPreferredEditor(pxt.BLOCKS_PROJECT_NAME);
                    host.writeFile(pkg, pxt.MAIN_BLOCKS, compileBlocks.outfiles[pxt.MAIN_BLOCKS]);
                }
                else if ($py && compilePython) {
                    pkg.setPreferredEditor(pxt.PYTHON_PROJECT_NAME);
                    host.writeFile(pkg, pxt.MAIN_PY, compileBlocks.outfiles[pxt.MAIN_PY]);
                }
                else {
                    pkg.setPreferredEditor(pxt.JAVASCRIPT_PROJECT_NAME);
                }
                if (options.assetJSON) {
                    for (const key of Object.keys(options.assetJSON)) {
                        if (pkg.config.files.indexOf(key) < 0) {
                            pkg.config.files.push(key);
                        }
                        host.writeFile(pkg, key, options.assetJSON[key]);
                    }
                }
                const compressed = pkg.compressToFileAsync();
                $editBtn.click(() => {
                    pxt.tickEvent("docs.btn", { button: "edit" });
                    compressed.then(buf => {
                        window.open(`${getEditUrl(options)}/#project:${ts.pxtc.encodeBase64(pxt.Util.uint8ArrayToString(buf))}`, 'pxt');
                    });
                });
                $menu.append($editBtn);
            }
            if (options.showJavaScript || (!$svg && !$py)) {
                // js
                $c.append($js);
                appendBlocksButton();
                appendPyButton();
            }
            else if ($svg) {
                // blocks
                $c.append($svg);
                appendJsButton();
                appendPyButton();
            }
            else if ($py) {
                $c.append($py);
                appendBlocksButton();
                appendJsButton();
            }
            // runner menu
            if (woptions.run && !theme.hideDocsSimulator) {
                let $runBtn = snippetBtn(lf("Run"), "play icon").click(() => {
                    pxt.tickEvent("docs.btn", { button: "sim" });
                    if ($c.find('.sim')[0]) {
                        $c.find('.sim').remove(); // remove previous simulators
                        scrollJQueryIntoView($c);
                    }
                    else {
                        let padding = '81.97%';
                        if (pxt.appTarget.simulator)
                            padding = (100 / pxt.appTarget.simulator.aspectRatio) + '%';
                        const deps = options.package ? "&deps=" + encodeURIComponent(options.package) : "";
                        const url = getRunUrl(options) + "#nofooter=1" + deps;
                        const assets = options.assetJSON ? `data-assets="${encodeURIComponent(JSON.stringify(options.assetJSON))}"` : "";
                        const data = encodeURIComponent($js.text());
                        let $embed = $(`<div class="ui card sim"><div class="ui content"><div style="position:relative;height:0;padding-bottom:${padding};overflow:hidden;"><iframe style="position:absolute;top:0;left:0;width:100%;height:100%;" src="${url}" data-code="${data}" ${assets} allowfullscreen="allowfullscreen" sandbox="allow-popups allow-forms allow-scripts allow-same-origin" frameborder="0"></iframe></div></div></div>`);
                        $c.append($embed);
                        scrollJQueryIntoView($embed);
                    }
                });
                $menu.append($runBtn);
            }
            if (woptions.hexname && woptions.hex) {
                let $hexBtn = snippetBtn(lf("Download"), "download icon").click(() => {
                    pxt.tickEvent("docs.btn", { button: "hex" });
                    pxt.BrowserUtils.browserDownloadBinText(woptions.hex, woptions.hexname, { contentType: pxt.appTarget.compile.hexMimeType });
                });
                $menu.append($hexBtn);
            }
            let r = $(`<div class=codesnippet></div>`);
            // don't add menu if empty
            if ($menu.children().length)
                r.append($h);
            r.append($c);
            // inject container
            $container.replaceWith(r);
            function appendBlocksButton() {
                if (!$svg)
                    return;
                const $svgBtn = snippetBtn(lf("Blocks"), BLOCKS_ICON).click(() => {
                    pxt.tickEvent("docs.btn", { button: "blocks" });
                    if ($c.find('.blocks')[0]) {
                        $c.find('.blocks').remove();
                        scrollJQueryIntoView($c);
                    }
                    else {
                        if ($js)
                            appendBlocks($js.parent(), $svg);
                        else
                            appendBlocks($c, $svg);
                        scrollJQueryIntoView($svg);
                    }
                });
                $menu.append($svgBtn);
            }
            function appendJsButton() {
                if (!$js)
                    return;
                if (woptions.showJs)
                    appendJs($c, $js, woptions);
                else {
                    const $jsBtn = snippetBtn("JavaScript", JS_ICON).click(() => {
                        pxt.tickEvent("docs.btn", { button: "js" });
                        if ($c.find('.js')[0]) {
                            $c.find('.js').remove();
                            scrollJQueryIntoView($c);
                        }
                        else {
                            if ($svg)
                                appendJs($svg.parent(), $js, woptions);
                            else
                                appendJs($c, $js, woptions);
                            scrollJQueryIntoView($js);
                        }
                    });
                    $menu.append($jsBtn);
                }
            }
            function appendPyButton() {
                if (!$py)
                    return;
                if (woptions.showPy) {
                    appendPy($c, $py, woptions);
                }
                else {
                    const $pyBtn = snippetBtn("Python", PY_ICON).click(() => {
                        pxt.tickEvent("docs.btn", { button: "py" });
                        if ($c.find('.py')[0]) {
                            $c.find('.py').remove();
                            scrollJQueryIntoView($c);
                        }
                        else {
                            if ($svg)
                                appendPy($svg.parent(), $py, woptions);
                            else
                                appendPy($c, $py, woptions);
                            scrollJQueryIntoView($py);
                        }
                    });
                    $menu.append($pyBtn);
                }
            }
            function scrollJQueryIntoView($toScrollTo) {
                var _a;
                (_a = $toScrollTo[0]) === null || _a === void 0 ? void 0 : _a.scrollIntoView({
                    behavior: "smooth",
                    block: "center"
                });
            }
        }
        let renderQueue = [];
        function consumeRenderQueueAsync() {
            const existingFilters = {};
            return consumeNext()
                .then(() => {
                Blockly.Workspace.getAll().forEach(el => el.dispose());
                pxt.blocks.cleanRenderingWorkspace();
            });
            function consumeNext() {
                const job = renderQueue.shift();
                if (!job)
                    return Promise.resolve(); // done
                const { el, options, render } = job;
                return pxt.runner.decompileSnippetAsync(el.text(), options)
                    .then(r => {
                    const errors = r.compileJS && r.compileJS.diagnostics && r.compileJS.diagnostics.filter(d => d.category == pxtc.DiagnosticCategory.Error);
                    if (errors && errors.length) {
                        errors.forEach(diag => pxt.reportError("docs.decompile", "" + diag.messageText, { "code": diag.code + "" }));
                    }
                    // filter out any blockly definitions from the svg that would be duplicates on the page
                    r.blocksSvg.querySelectorAll("defs *").forEach(el => {
                        if (existingFilters[el.id]) {
                            el.remove();
                        }
                        else {
                            existingFilters[el.id] = true;
                        }
                    });
                    render(el, r);
                }, e => {
                    pxt.reportException(e);
                    el.append($('<div/>').addClass("ui segment warning").text(e.message));
                }).finally(() => {
                    el.removeClass("lang-shadow");
                    return consumeNext();
                });
            }
        }
        function renderNextSnippetAsync(cls, render, options) {
            if (!cls)
                return Promise.resolve();
            let $el = $("." + cls).first();
            if (!$el[0])
                return Promise.resolve();
            if (!options.emPixels)
                options.emPixels = 18;
            if (!options.layout)
                options.layout = pxt.blocks.BlockLayout.Align;
            options.splitSvg = true;
            renderQueue.push({ el: $el, source: $el.text(), options, render });
            $el.addClass("lang-shadow");
            $el.removeClass(cls);
            return renderNextSnippetAsync(cls, render, options);
        }
        function renderSnippetsAsync(options) {
            if (options.tutorial) {
                // don't render chrome for tutorials
                return renderNextSnippetAsync(options.snippetClass, (c, r) => {
                    const s = r.blocksSvg;
                    if (options.snippetReplaceParent)
                        c = c.parent();
                    const segment = $('<div class="ui segment codewidget"/>').append(s);
                    c.replaceWith(segment);
                }, { package: options.package, snippetMode: false, aspectRatio: options.blocksAspectRatio, assets: options.assetJSON });
            }
            let snippetCount = 0;
            return renderNextSnippetAsync(options.snippetClass, (c, r) => {
                const s = r.compileBlocks && r.compileBlocks.success ? $(r.blocksSvg) : undefined;
                const p = r.compilePython && r.compilePython.success && r.compilePython.outfiles[pxt.MAIN_PY];
                const js = $('<code class="lang-typescript highlight"/>').text(c.text().trim());
                const py = p ? $('<code class="lang-python highlight"/>').text(p.trim()) : undefined;
                if (options.snippetReplaceParent)
                    c = c.parent();
                const compiled = r.compileJS && r.compileJS.success;
                // TODO should this use pxt.outputName() and not pxtc.BINARY_HEX
                const hex = options.hex && compiled && r.compileJS.outfiles[pxtc.BINARY_HEX]
                    ? r.compileJS.outfiles[pxtc.BINARY_HEX] : undefined;
                const hexname = `${pxt.appTarget.nickname || pxt.appTarget.id}-${options.hexName || ''}-${snippetCount++}.hex`;
                fillWithWidget(options, c, js, py, s, r, {
                    showEdit: options.showEdit,
                    run: options.simulator,
                    hexname: hexname,
                    hex: hex,
                });
            }, { package: options.package, aspectRatio: options.blocksAspectRatio, assets: options.assetJSON });
        }
        function decompileCallInfo(stmt) {
            if (!stmt || stmt.kind != ts.SyntaxKind.ExpressionStatement)
                return null;
            let estmt = stmt;
            if (!estmt.expression || estmt.expression.kind != ts.SyntaxKind.CallExpression)
                return null;
            let call = estmt.expression;
            let info = pxtc.pxtInfo(call).callInfo;
            return info;
        }
        function renderSignaturesAsync(options) {
            return renderNextSnippetAsync(options.signatureClass, (c, r) => {
                var _a, _b, _c, _d;
                let cjs = r.compileProgram;
                if (!cjs)
                    return;
                let file = cjs.getSourceFile(pxt.MAIN_TS);
                let info = decompileCallInfo(file.statements[0]);
                if (!info || !r.apiInfo)
                    return;
                const symbolInfo = r.apiInfo.byQName[info.qName];
                if (!symbolInfo)
                    return;
                let block = Blockly.Blocks[symbolInfo.attributes.blockId];
                let xml = ((_a = block === null || block === void 0 ? void 0 : block.codeCard) === null || _a === void 0 ? void 0 : _a.blocksXml) || undefined;
                const blocksHtml = xml ? pxt.blocks.render(xml) : ((_b = r.compileBlocks) === null || _b === void 0 ? void 0 : _b.success) ? r.blocksSvg : undefined;
                const s = blocksHtml ? $(blocksHtml) : undefined;
                let jsSig = ts.pxtc.service.displayStringForSymbol(symbolInfo, /** python **/ false, r.apiInfo)
                    .split("\n")[1] + ";";
                const js = $('<code class="lang-typescript highlight"/>').text(jsSig);
                const pySig = ((_d = (_c = pxt.appTarget) === null || _c === void 0 ? void 0 : _c.appTheme) === null || _d === void 0 ? void 0 : _d.python) && ts.pxtc.service.displayStringForSymbol(symbolInfo, /** python **/ true, r.apiInfo).split("\n")[1];
                const py = pySig && $('<code class="lang-python highlight"/>').text(pySig);
                if (options.snippetReplaceParent)
                    c = c.parent();
                // add an html widge that allows to translate the block
                if (pxt.Util.isTranslationMode()) {
                    const trs = $('<div class="ui segment" />');
                    trs.append($(`<div class="ui header"><i class="ui xicon globe"></i></div>`));
                    if (symbolInfo.attributes.translationId)
                        trs.append($('<div class="ui message">').text(symbolInfo.attributes.translationId));
                    if (symbolInfo.attributes.jsDoc)
                        trs.append($('<div class="ui message">').text(symbolInfo.attributes.jsDoc));
                    trs.insertAfter(c);
                }
                fillWithWidget(options, c, js, py, s, r, { showJs: true, showPy: true, hideGutter: true });
            }, { package: options.package, snippetMode: true, aspectRatio: options.blocksAspectRatio, assets: options.assetJSON });
        }
        function renderBlocksAsync(options) {
            return renderNextSnippetAsync(options.blocksClass, (c, r) => {
                const s = r.blocksSvg;
                if (options.snippetReplaceParent)
                    c = c.parent();
                const segment = $('<div class="ui segment codewidget"/>').append(s);
                c.replaceWith(segment);
            }, { package: options.package, snippetMode: true, aspectRatio: options.blocksAspectRatio, assets: options.assetJSON });
        }
        function renderStaticPythonAsync(options) {
            // Highlight python snippets if the snippet has compile python
            const woptions = {
                showEdit: !!options.showEdit,
                run: !!options.simulator
            };
            return renderNextSnippetAsync(options.staticPythonClass, (c, r) => {
                const s = r.compilePython;
                if (s && s.success) {
                    const $js = c.clone().removeClass('lang-shadow').addClass('highlight');
                    const $py = $js.clone().addClass('lang-python').text(s.outfiles[pxt.MAIN_PY]);
                    $js.addClass('lang-typescript');
                    highlight($py);
                    fillWithWidget(options, c.parent(), /* js */ $js, /* py */ $py, /* svg */ undefined, r, woptions);
                }
            }, { package: options.package, snippetMode: true, assets: options.assetJSON });
        }
        function renderBlocksXmlAsync(opts) {
            if (!opts.blocksXmlClass)
                return Promise.resolve();
            const cls = opts.blocksXmlClass;
            function renderNextXmlAsync(cls, render, options) {
                let $el = $("." + cls).first();
                if (!$el[0])
                    return Promise.resolve();
                if (!options.emPixels)
                    options.emPixels = 18;
                options.splitSvg = true;
                return pxt.runner.compileBlocksAsync($el.text(), options)
                    .then((r) => {
                    try {
                        render($el, r);
                    }
                    catch (e) {
                        pxt.reportException(e);
                        $el.append($('<div/>').addClass("ui segment warning").text(e.message));
                    }
                    $el.removeClass(cls);
                    return pxt.U.delay(1, renderNextXmlAsync(cls, render, options));
                });
            }
            return renderNextXmlAsync(cls, (c, r) => {
                const s = r.blocksSvg;
                if (opts.snippetReplaceParent)
                    c = c.parent();
                const segment = $('<div class="ui segment codewidget"/>').append(s);
                c.replaceWith(segment);
            }, { package: opts.package, snippetMode: true, aspectRatio: opts.blocksAspectRatio, assets: opts.assetJSON });
        }
        function renderDiffBlocksXmlAsync(opts) {
            if (!opts.diffBlocksXmlClass)
                return Promise.resolve();
            const cls = opts.diffBlocksXmlClass;
            function renderNextXmlAsync(cls, render, options) {
                let $el = $("." + cls).first();
                if (!$el[0])
                    return Promise.resolve();
                if (!options.emPixels)
                    options.emPixels = 18;
                options.splitSvg = true;
                const xml = $el.text().split(/-{10,}/);
                const oldXml = xml[0];
                const newXml = xml[1];
                return pxt.runner.compileBlocksAsync("", options) // force loading blocks
                    .then(r => {
                    $el.removeClass(cls);
                    try {
                        const diff = pxt.blocks.diffXml(oldXml, newXml);
                        if (!diff)
                            $el.text("no changes");
                        else {
                            r.blocksSvg = diff.svg;
                            render($el, r);
                        }
                    }
                    catch (e) {
                        pxt.reportException(e);
                        $el.append($('<div/>').addClass("ui segment warning").text(e.message));
                    }
                    return pxt.U.delay(1, renderNextXmlAsync(cls, render, options));
                });
            }
            return renderNextXmlAsync(cls, (c, r) => {
                const s = r.blocksSvg;
                if (opts.snippetReplaceParent)
                    c = c.parent();
                const segment = $('<div class="ui segment codewidget"/>').append(s);
                c.replaceWith(segment);
            }, { package: opts.package, snippetMode: true, aspectRatio: opts.blocksAspectRatio, assets: opts.assetJSON });
        }
        function renderDiffAsync(opts) {
            if (!opts.diffClass)
                return Promise.resolve();
            const cls = opts.diffClass;
            function renderNextDiffAsync(cls) {
                let $el = $("." + cls).first();
                if (!$el[0])
                    return Promise.resolve();
                const { fileA: oldSrc, fileB: newSrc } = pxt.diff.split($el.text());
                try {
                    const diffEl = pxt.diff.render(oldSrc, newSrc, {
                        hideLineNumbers: true,
                        hideMarkerLine: true,
                        hideMarker: true,
                        hideRemoved: true,
                        update: true,
                        ignoreWhitespace: true,
                    });
                    if (opts.snippetReplaceParent)
                        $el = $el.parent();
                    const segment = $('<div class="ui segment codewidget"/>').append(diffEl);
                    $el.removeClass(cls);
                    $el.replaceWith(segment);
                }
                catch (e) {
                    pxt.reportException(e);
                    $el.append($('<div/>').addClass("ui segment warning").text(e.message));
                }
                return pxt.U.delay(1, renderNextDiffAsync(cls));
            }
            return renderNextDiffAsync(cls);
        }
        function renderDiffBlocksAsync(opts) {
            if (!opts.diffBlocksClass)
                return Promise.resolve();
            const cls = opts.diffBlocksClass;
            function renderNextDiffAsync(cls) {
                let $el = $("." + cls).first();
                if (!$el[0])
                    return Promise.resolve();
                const { fileA: oldSrc, fileB: newSrc } = pxt.diff.split($el.text(), {
                    removeTrailingSemiColumns: true
                });
                return pxt.U.promiseMapAllSeries([oldSrc, newSrc], src => pxt.runner.decompileSnippetAsync(src, {
                    generateSourceMap: true
                }))
                    .then(resps => {
                    try {
                        const diffBlocks = pxt.blocks.decompiledDiffAsync(oldSrc, resps[0].compileBlocks, newSrc, resps[1].compileBlocks, {
                            hideDeletedTopBlocks: true,
                            hideDeletedBlocks: true
                        });
                        const diffJs = pxt.diff.render(oldSrc, newSrc, {
                            hideLineNumbers: true,
                            hideMarkerLine: true,
                            hideMarker: true,
                            hideRemoved: true,
                            update: true,
                            ignoreWhitespace: true
                        });
                        let diffPy;
                        const [oldPy, newPy] = resps.map(resp => resp.compilePython
                            && resp.compilePython.outfiles
                            && resp.compilePython.outfiles[pxt.MAIN_PY]);
                        if (oldPy && newPy) {
                            diffPy = pxt.diff.render(oldPy, newPy, {
                                hideLineNumbers: true,
                                hideMarkerLine: true,
                                hideMarker: true,
                                hideRemoved: true,
                                update: true,
                                ignoreWhitespace: true
                            });
                        }
                        fillWithWidget(opts, $el.parent(), $(diffJs), diffPy && $(diffPy), $(diffBlocks.svg), undefined, {
                            showEdit: false,
                            run: false,
                            hexname: undefined,
                            hex: undefined
                        });
                    }
                    catch (e) {
                        pxt.reportException(e);
                        $el.append($('<div/>').addClass("ui segment warning").text(e.message));
                    }
                    return pxt.U.delay(1, renderNextDiffAsync(cls));
                });
            }
            return renderNextDiffAsync(cls);
        }
        let decompileApiPromise;
        function decompileApiAsync(options) {
            if (!decompileApiPromise)
                decompileApiPromise = pxt.runner.decompileSnippetAsync('', options);
            return decompileApiPromise;
        }
        function renderNamespaces(options) {
            if (pxt.appTarget.id == "core")
                return Promise.resolve();
            return decompileApiAsync(options)
                .then((r) => {
                let res = {};
                const info = r.compileBlocks.blocksInfo;
                info.blocks.forEach(fn => {
                    const ns = (fn.attributes.blockNamespace || fn.namespace).split('.')[0];
                    if (!res[ns]) {
                        const nsn = info.apis.byQName[ns];
                        if (nsn && nsn.attributes.color)
                            res[ns] = nsn.attributes.color;
                    }
                });
                let nsStyleBuffer = '';
                Object.keys(res).forEach(ns => {
                    const color = res[ns] || '#dddddd';
                    nsStyleBuffer += `
                        span.docs.${ns.toLowerCase()} {
                            background-color: ${color} !important;
                            border-color: ${pxt.toolbox.fadeColor(color, 0.1, false)} !important;
                        }
                    `;
                });
                return nsStyleBuffer;
            })
                .then((nsStyleBuffer) => {
                Object.keys(pxt.toolbox.blockColors).forEach((ns) => {
                    const color = pxt.toolbox.getNamespaceColor(ns);
                    nsStyleBuffer += `
                        span.docs.${ns.toLowerCase()} {
                            background-color: ${color} !important;
                            border-color: ${pxt.toolbox.fadeColor(color, 0.1, false)} !important;
                        }
                    `;
                });
                return nsStyleBuffer;
            })
                .then((nsStyleBuffer) => {
                // Inject css
                let nsStyle = document.createElement('style');
                nsStyle.id = "namespaceColors";
                nsStyle.type = 'text/css';
                let head = document.head || document.getElementsByTagName('head')[0];
                head.appendChild(nsStyle);
                nsStyle.appendChild(document.createTextNode(nsStyleBuffer));
            });
        }
        function renderInlineBlocksAsync(options) {
            options = pxt.Util.clone(options);
            options.emPixels = 18;
            options.snippetMode = true;
            const $els = $(`:not(pre) > code`);
            let i = 0;
            function renderNextAsync() {
                if (i >= $els.length)
                    return Promise.resolve();
                const $el = $($els[i++]);
                const text = $el.text();
                const mbtn = /^(\|+)([^\|]+)\|+$/.exec(text);
                if (mbtn) {
                    const mtxt = /^(([^\:\.]*?)[\:\.])?(.*)$/.exec(mbtn[2]);
                    const ns = mtxt[2] ? mtxt[2].trim().toLowerCase() : '';
                    const lev = mbtn[1].length == 1 ? `docs inlinebutton ${ns}` : `docs inlineblock ${ns}`;
                    const txt = mtxt[3].trim();
                    $el.replaceWith($(`<span class="${lev}"/>`).text(pxt.U.rlf(txt)));
                    return renderNextAsync();
                }
                const m = /^\[(.+)\]$/.exec(text);
                if (!m)
                    return renderNextAsync();
                const code = m[1];
                return pxt.runner.decompileSnippetAsync(code, options)
                    .then(r => {
                    if (r.blocksSvg) {
                        let $newel = $('<span class="block"/>').append(r.blocksSvg);
                        const file = r.compileProgram.getSourceFile(pxt.MAIN_TS);
                        const stmt = file.statements[0];
                        const info = decompileCallInfo(stmt);
                        if (info && r.apiInfo) {
                            const symbolInfo = r.apiInfo.byQName[info.qName];
                            if (symbolInfo && symbolInfo.attributes.help) {
                                $newel = $(`<a class="ui link"/>`).attr("href", `/reference/${symbolInfo.attributes.help}`).append($newel);
                            }
                        }
                        $el.replaceWith($newel);
                    }
                    return pxt.U.delay(1, renderNextAsync());
                });
            }
            return renderNextAsync();
        }
        function renderProjectAsync(options) {
            if (!options.projectClass)
                return Promise.resolve();
            function render() {
                let $el = $("." + options.projectClass).first();
                let e = $el[0];
                if (!e)
                    return Promise.resolve();
                $el.removeClass(options.projectClass);
                let id = pxt.Cloud.parseScriptId(e.innerText);
                if (id) {
                    if (options.snippetReplaceParent) {
                        e = e.parentElement;
                        // create a new div to host the rendered code
                        let d = document.createElement("div");
                        e.parentElement.insertBefore(d, e);
                        e.parentElement.removeChild(e);
                        e = d;
                    }
                    return pxt.runner.renderProjectAsync(e, id)
                        .then(() => render());
                }
                else
                    return render();
            }
            return render();
        }
        function renderApisAsync(options, replaceParent) {
            const cls = options.apisClass;
            if (!cls)
                return Promise.resolve();
            const apisEl = $('.' + cls);
            if (!apisEl.length)
                return Promise.resolve();
            return decompileApiAsync(options)
                .then((r) => {
                const info = r.compileBlocks.blocksInfo;
                const symbols = pxt.Util.values(info.apis.byQName)
                    .filter(symbol => !symbol.attributes.hidden
                    && !symbol.attributes.deprecated
                    && !symbol.attributes.blockAliasFor
                    && !!symbol.attributes.jsDoc
                    && !!symbol.attributes.block
                    && !/^__/.test(symbol.name));
                apisEl.each((i, e) => {
                    let c = $(e);
                    const namespaces = pxt.Util.toDictionary(c.text().split('\n'), n => n); // list of namespace to list apis for.
                    const csymbols = symbols.filter(symbol => !!namespaces[symbol.attributes.blockNamespace || symbol.namespace]);
                    if (!csymbols.length)
                        return;
                    csymbols.sort((l, r) => {
                        // render cards first
                        const lcard = !l.attributes.blockHidden && Blockly.Blocks[l.attributes.blockId];
                        const rcard = !r.attributes.blockHidden && Blockly.Blocks[r.attributes.blockId];
                        if (!!lcard != !!rcard)
                            return -(lcard ? 1 : 0) + (rcard ? 1 : 0);
                        // sort alphabetically
                        return l.name.localeCompare(r.name);
                    });
                    const ul = $('<div />').addClass('ui divided items');
                    ul.attr("role", "listbox");
                    csymbols.forEach(symbol => addSymbolCardItem(ul, symbol, "item"));
                    if (replaceParent)
                        c = c.parent();
                    c.replaceWith(ul);
                });
            });
        }
        function addCardItem(ul, card) {
            if (!card)
                return;
            const mC = /^\/(v\d+)/.exec(card.url);
            const mP = /^\/(v\d+)/.exec(window.location.pathname);
            const inEditor = /#doc/i.test(window.location.href);
            if (card.url && !mC && mP && !inEditor)
                card.url = `/${mP[1]}/${card.url}`;
            ul.append(pxt.docs.codeCard.render(card, { hideHeader: true, shortName: true }));
        }
        function addSymbolCardItem(ul, symbol, cardStyle) {
            const attributes = symbol.attributes;
            const block = !attributes.blockHidden && Blockly.Blocks[attributes.blockId];
            const card = block === null || block === void 0 ? void 0 : block.codeCard;
            if (card) {
                const ccard = pxt.U.clone(block.codeCard);
                if (cardStyle)
                    ccard.style = cardStyle;
                addCardItem(ul, ccard);
            }
            else {
                // default to text
                // no block available here
                addCardItem(ul, {
                    name: symbol.qName,
                    description: attributes.jsDoc,
                    url: attributes.help || undefined,
                    style: cardStyle
                });
            }
        }
        function renderLinksAsync(options, cls, replaceParent, ns) {
            return renderNextSnippetAsync(cls, (c, r) => {
                const cjs = r.compileProgram;
                if (!cjs)
                    return;
                const file = cjs.getSourceFile(pxt.MAIN_TS);
                const stmts = file.statements.slice(0);
                const ul = $('<div />').addClass('ui cards');
                ul.attr("role", "listbox");
                stmts.forEach(stmt => {
                    const kind = stmt.kind;
                    const info = decompileCallInfo(stmt);
                    if (info && r.apiInfo && r.apiInfo.byQName[info.qName]) {
                        const symbol = r.apiInfo.byQName[info.qName];
                        const attributes = symbol.attributes;
                        const block = Blockly.Blocks[attributes.blockId];
                        if (ns) {
                            const ii = symbol;
                            const nsi = r.compileBlocks.blocksInfo.apis.byQName[ii.namespace];
                            addCardItem(ul, {
                                name: nsi.attributes.blockNamespace || nsi.name,
                                url: nsi.attributes.help || ("reference/" + (nsi.attributes.blockNamespace || nsi.name).toLowerCase()),
                                description: nsi.attributes.jsDoc,
                                blocksXml: block && block.codeCard
                                    ? block.codeCard.blocksXml
                                    : attributes.blockId
                                        ? `<xml xmlns="http://www.w3.org/1999/xhtml"><block type="${attributes.blockId}"></block></xml>`
                                        : undefined
                            });
                        }
                        else {
                            addSymbolCardItem(ul, symbol);
                        }
                    }
                    else
                        switch (kind) {
                            case ts.SyntaxKind.ExpressionStatement: {
                                const es = stmt;
                                switch (es.expression.kind) {
                                    case ts.SyntaxKind.TrueKeyword:
                                    case ts.SyntaxKind.FalseKeyword:
                                        addCardItem(ul, {
                                            name: "Boolean",
                                            url: "blocks/logic/boolean",
                                            description: lf("True or false values"),
                                            blocksXml: '<xml xmlns="http://www.w3.org/1999/xhtml"><block type="logic_boolean"><field name="BOOL">TRUE</field></block></xml>'
                                        });
                                        break;
                                    default:
                                        pxt.debug(`card expr kind: ${es.expression.kind}`);
                                        break;
                                }
                                break;
                            }
                            case ts.SyntaxKind.IfStatement:
                                addCardItem(ul, {
                                    name: ns ? "Logic" : "if",
                                    url: "blocks/logic" + (ns ? "" : "/if"),
                                    description: ns ? lf("Logic operators and constants") : lf("Conditional statement"),
                                    blocksXml: '<xml xmlns="http://www.w3.org/1999/xhtml"><block type="controls_if"></block></xml>'
                                });
                                break;
                            case ts.SyntaxKind.WhileStatement:
                                addCardItem(ul, {
                                    name: ns ? "Loops" : "while",
                                    url: "blocks/loops" + (ns ? "" : "/while"),
                                    description: ns ? lf("Loops and repetition") : lf("Repeat code while a condition is true."),
                                    blocksXml: '<xml xmlns="http://www.w3.org/1999/xhtml"><block type="device_while"></block></xml>'
                                });
                                break;
                            case ts.SyntaxKind.ForOfStatement:
                                addCardItem(ul, {
                                    name: ns ? "Loops" : "for of",
                                    url: "blocks/loops" + (ns ? "" : "/for-of"),
                                    description: ns ? lf("Loops and repetition") : lf("Repeat code for each item in a list."),
                                    blocksXml: '<xml xmlns="http://www.w3.org/1999/xhtml"><block type="controls_for_of"></block></xml>'
                                });
                                break;
                            case ts.SyntaxKind.BreakStatement:
                                addCardItem(ul, {
                                    name: ns ? "Loops" : "break",
                                    url: "blocks/loops" + (ns ? "" : "/break"),
                                    description: ns ? lf("Loops and repetition") : lf("Break out of the current loop."),
                                    blocksXml: '<xml xmlns="http://www.w3.org/1999/xhtml"><block type="break_keyword"></block></xml>'
                                });
                                break;
                            case ts.SyntaxKind.ContinueStatement:
                                addCardItem(ul, {
                                    name: ns ? "Loops" : "continue",
                                    url: "blocks/loops" + (ns ? "" : "/continue"),
                                    description: ns ? lf("Loops and repetition") : lf("Skip iteration and continue the current loop."),
                                    blocksXml: '<xml xmlns="http://www.w3.org/1999/xhtml"><block type="continue_keyboard"></block></xml>'
                                });
                                break;
                            case ts.SyntaxKind.ForStatement: {
                                let fs = stmt;
                                // look for the 'repeat' loop style signature in the condition expression, explicitly: (let i = 0; i < X; i++)
                                // for loops will have the '<=' conditional.
                                let forloop = true;
                                if (fs.condition.getChildCount() == 3) {
                                    forloop = !(fs.condition.getChildAt(0).getText() == "0" ||
                                        fs.condition.getChildAt(1).kind == ts.SyntaxKind.LessThanToken);
                                }
                                if (forloop) {
                                    addCardItem(ul, {
                                        name: ns ? "Loops" : "for",
                                        url: "blocks/loops" + (ns ? "" : "/for"),
                                        description: ns ? lf("Loops and repetition") : lf("Repeat code for a given number of times using an index."),
                                        blocksXml: '<xml xmlns="http://www.w3.org/1999/xhtml"><block type="controls_simple_for"></block></xml>'
                                    });
                                }
                                else {
                                    addCardItem(ul, {
                                        name: ns ? "Loops" : "repeat",
                                        url: "blocks/loops" + (ns ? "" : "/repeat"),
                                        description: ns ? lf("Loops and repetition") : lf("Repeat code for a given number of times."),
                                        blocksXml: '<xml xmlns="http://www.w3.org/1999/xhtml"><block type="controls_repeat_ext"></block></xml>'
                                    });
                                }
                                break;
                            }
                            case ts.SyntaxKind.VariableStatement:
                                addCardItem(ul, {
                                    name: ns ? "Variables" : "variable declaration",
                                    url: "blocks/variables" + (ns ? "" : "/assign"),
                                    description: ns ? lf("Variables") : lf("Assign a value to a named variable."),
                                    blocksXml: '<xml xmlns="http://www.w3.org/1999/xhtml"><block type="variables_set"></block></xml>'
                                });
                                break;
                            default:
                                pxt.debug(`card kind: ${kind}`);
                        }
                });
                if (replaceParent)
                    c = c.parent();
                c.replaceWith(ul);
            }, { package: options.package, aspectRatio: options.blocksAspectRatio, assets: options.assetJSON });
        }
        function fillCodeCardAsync(c, cards, options) {
            if (!cards || cards.length == 0)
                return Promise.resolve();
            if (cards.length == 0) {
                let cc = pxt.docs.codeCard.render(cards[0], options);
                c.replaceWith(cc);
            }
            else {
                let cd = document.createElement("div");
                cd.className = "ui cards";
                cd.setAttribute("role", "listbox");
                cards.forEach(card => {
                    // patch card url with version if necessary, we don't do this in the editor because that goes through the backend and passes the targetVersion then
                    const mC = /^\/(v\d+)/.exec(card.url);
                    const mP = /^\/(v\d+)/.exec(window.location.pathname);
                    const inEditor = /#doc/i.test(window.location.href);
                    if (card.url && !mC && mP && !inEditor)
                        card.url = `/${mP[1]}${card.url}`;
                    const cardEl = pxt.docs.codeCard.render(card, options);
                    cd.appendChild(cardEl);
                    // automitcally display package icon for approved packages
                    if (card.cardType == "package") {
                        const repoId = pxt.github.parseRepoId((card.url || "").replace(/^\/pkg\//, ''));
                        if (repoId) {
                            pxt.packagesConfigAsync()
                                .then(pkgConfig => {
                                const status = pxt.github.repoStatus(repoId, pkgConfig);
                                switch (status) {
                                    case pxt.github.GitRepoStatus.Banned:
                                        cardEl.remove();
                                        break;
                                    case pxt.github.GitRepoStatus.Approved:
                                        // update card info
                                        card.imageUrl = pxt.github.mkRepoIconUrl(repoId);
                                        // inject
                                        cd.insertBefore(pxt.docs.codeCard.render(card, options), cardEl);
                                        cardEl.remove();
                                        break;
                                }
                            })
                                .catch(e => {
                                // swallow
                                pxt.reportException(e);
                                pxt.debug(`failed to load repo ${card.url}`);
                            });
                        }
                    }
                });
                c.replaceWith(cd);
            }
            return Promise.resolve();
        }
        function renderNextCodeCardAsync(cls, options) {
            if (!cls)
                return Promise.resolve();
            let $el = $("." + cls).first();
            if (!$el[0])
                return Promise.resolve();
            $el.removeClass(cls);
            // try parsing the card as json
            const cards = pxt.gallery.parseCodeCardsHtml($el[0]);
            if (!cards) {
                $el.append($('<div/>').addClass("ui segment warning").text("invalid codecard format"));
            }
            if (options.snippetReplaceParent)
                $el = $el.parent();
            return fillCodeCardAsync($el, cards, { hideHeader: true })
                .then(() => pxt.U.delay(1, renderNextCodeCardAsync(cls, options)));
        }
        function getRunUrl(options) {
            return options.pxtUrl ? options.pxtUrl + '/--run' : pxt.webConfig && pxt.webConfig.runUrl ? pxt.webConfig.runUrl : '/--run';
        }
        function getEditUrl(options) {
            const url = options.pxtUrl || pxt.appTarget.appTheme.homeUrl;
            return (url || "").replace(/\/$/, '');
        }
        function mergeConfig(options) {
            // additional config options
            if (!options.packageClass)
                return;
            $('.' + options.packageClass).each((i, c) => {
                let $c = $(c);
                let name = $c.text().split('\n').map(s => s.replace(/\s*/g, '')).filter(s => !!s).join(',');
                options.package = options.package ? `${options.package},${name}` : name;
                if (options.snippetReplaceParent)
                    $c = $c.parent();
                $c.remove();
            });
            $('.lang-config').each((i, c) => {
                let $c = $(c);
                if (options.snippetReplaceParent)
                    $c = $c.parent();
                $c.remove();
            });
        }
        function readAssetJson(options) {
            let assetJson;
            let tilemapJres;
            if (options.jresClass) {
                $(`.${options.jresClass}`).each((i, c) => {
                    const $c = $(c);
                    tilemapJres = $c.text();
                    c.parentElement.remove();
                });
            }
            if (options.assetJSONClass) {
                $(`.${options.assetJSONClass}`).each((i, c) => {
                    const $c = $(c);
                    assetJson = $c.text();
                    c.parentElement.remove();
                });
            }
            options.assetJSON = mergeAssetJson(assetJson, tilemapJres);
            function mergeAssetJson(assetJSON, tilemapJres) {
                if (!assetJSON && !tilemapJres)
                    return undefined;
                const mergedJson = pxt.tutorial.parseAssetJson(assetJSON) || {};
                if (tilemapJres) {
                    const parsedTmapJres = JSON.parse(tilemapJres);
                    mergedJson[pxt.TILEMAP_JRES] = JSON.stringify(parsedTmapJres);
                    mergedJson[pxt.TILEMAP_CODE] = pxt.emitTilemapsFromJRes(parsedTmapJres);
                }
                return mergedJson;
            }
        }
        function renderDirectPython(options) {
            // Highlight python snippets written with the ```python
            // language tag (as opposed to the ```spy tag, see renderStaticPythonAsync for that)
            const woptions = {
                showEdit: !!options.showEdit,
                run: !!options.simulator
            };
            function render(e, ignored) {
                if (typeof hljs !== "undefined") {
                    $(e).text($(e).text().replace(/^\s*\r?\n/, ''));
                    hljs.highlightBlock(e);
                    highlightLine($(e));
                }
                const opts = pxt.U.clone(woptions);
                if (ignored) {
                    opts.run = false;
                    opts.showEdit = false;
                }
                fillWithWidget(options, $(e).parent(), $(e), /* py */ undefined, /* JQuery */ undefined, /* decompileResult */ undefined, opts);
            }
            $('code.lang-python').each((i, e) => {
                render(e, false);
                $(e).removeClass('lang-python');
            });
        }
        function renderTypeScript(options) {
            const woptions = {
                showEdit: !!options.showEdit,
                run: !!options.simulator
            };
            function render(e, ignored) {
                if (typeof hljs !== "undefined") {
                    $(e).text($(e).text().replace(/^\s*\r?\n/, ''));
                    hljs.highlightBlock(e);
                    highlightLine($(e));
                }
                const opts = pxt.U.clone(woptions);
                if (ignored) {
                    opts.run = false;
                    opts.showEdit = false;
                }
                fillWithWidget(options, $(e).parent(), $(e), /* py */ undefined, /* JQuery */ undefined, /* decompileResult */ undefined, opts);
            }
            $('code.lang-typescript').each((i, e) => {
                render(e, false);
                $(e).removeClass('lang-typescript');
            });
            $('code.lang-typescript-ignore').each((i, e) => {
                $(e).removeClass('lang-typescript-ignore');
                $(e).addClass('lang-typescript');
                render(e, true);
                $(e).removeClass('lang-typescript');
            });
            $('code.lang-typescript-invalid').each((i, e) => {
                $(e).removeClass('lang-typescript-invalid');
                $(e).addClass('lang-typescript');
                render(e, true);
                $(e).removeClass('lang-typescript');
                $(e).parent('div').addClass('invalid');
                $(e).parent('div').prepend($("<i>", { "class": "icon ban" }));
                $(e).addClass('invalid');
            });
            $('code.lang-typescript-valid').each((i, e) => {
                $(e).removeClass('lang-typescript-valid');
                $(e).addClass('lang-typescript');
                render(e, true);
                $(e).removeClass('lang-typescript');
                $(e).parent('div').addClass('valid');
                $(e).parent('div').prepend($("<i>", { "class": "icon check" }));
                $(e).addClass('valid');
            });
        }
        function renderGhost(options) {
            let c = $('code.lang-ghost');
            if (options.snippetReplaceParent)
                c = c.parent();
            c.remove();
        }
        function renderSims(options) {
            if (!options.simulatorClass)
                return;
            // simulators
            $('.' + options.simulatorClass).each((i, c) => {
                let $c = $(c);
                let padding = '81.97%';
                if (pxt.appTarget.simulator)
                    padding = (100 / pxt.appTarget.simulator.aspectRatio) + '%';
                let $sim = $(`<div class="ui card"><div class="ui content">
                    <div style="position:relative;height:0;padding-bottom:${padding};overflow:hidden;">
                    <iframe style="position:absolute;top:0;left:0;width:100%;height:100%;" allowfullscreen="allowfullscreen" frameborder="0" sandbox="allow-popups allow-forms allow-scripts allow-same-origin"></iframe>
                    </div>
                    </div></div>`);
                const deps = options.package ? "&deps=" + encodeURIComponent(options.package) : "";
                const url = getRunUrl(options) + "#nofooter=1" + deps;
                const data = encodeURIComponent($c.text().trim());
                const $simIFrame = $sim.find("iframe");
                $simIFrame.attr("src", url);
                $simIFrame.attr("data-code", data);
                if (options.assetJSON) {
                    $simIFrame.attr("data-assets", JSON.stringify(options.assetJSON));
                }
                if (options.snippetReplaceParent)
                    $c = $c.parent();
                $c.replaceWith($sim);
            });
        }
        function renderAsync(options) {
            pxt.analytics.enable();
            if (!options)
                options = defaultClientRenderOptions();
            if (options.pxtUrl)
                options.pxtUrl = options.pxtUrl.replace(/\/$/, '');
            if (options.showEdit)
                options.showEdit = !pxt.BrowserUtils.isIFrame();
            mergeConfig(options);
            readAssetJson(options);
            renderQueue = [];
            renderGhost(options);
            renderSims(options);
            renderTypeScript(options);
            renderDirectPython(options);
            return Promise.resolve()
                .then(() => renderNextCodeCardAsync(options.codeCardClass, options))
                .then(() => renderNamespaces(options))
                .then(() => renderInlineBlocksAsync(options))
                .then(() => renderLinksAsync(options, options.linksClass, options.snippetReplaceParent, false))
                .then(() => renderLinksAsync(options, options.namespacesClass, options.snippetReplaceParent, true))
                .then(() => renderApisAsync(options, options.snippetReplaceParent))
                .then(() => renderSignaturesAsync(options))
                .then(() => renderSnippetsAsync(options))
                .then(() => renderBlocksAsync(options))
                .then(() => renderBlocksXmlAsync(options))
                .then(() => renderDiffBlocksXmlAsync(options))
                .then(() => renderDiffBlocksAsync(options))
                .then(() => renderDiffAsync(options))
                .then(() => renderStaticPythonAsync(options))
                .then(() => renderProjectAsync(options))
                .then(() => consumeRenderQueueAsync());
        }
        runner.renderAsync = renderAsync;
    })(runner = pxt.runner || (pxt.runner = {}));
})(pxt || (pxt = {}));
/* TODO(tslint): get rid of jquery html() calls */
/// <reference path="../built/pxtlib.d.ts" />
/// <reference path="../built/pxteditor.d.ts" />
/// <reference path="../built/pxtcompiler.d.ts" />
/// <reference path="../built/pxtblocks.d.ts" />
/// <reference path="../built/pxtsim.d.ts" />
var pxt;
(function (pxt) {
    var runner;
    (function (runner) {
        class EditorPackage {
            constructor(ksPkg, topPkg) {
                this.ksPkg = ksPkg;
                this.topPkg = topPkg;
                this.files = {};
            }
            getKsPkg() {
                return this.ksPkg;
            }
            getPkgId() {
                return this.ksPkg ? this.ksPkg.id : this.id;
            }
            isTopLevel() {
                return this.ksPkg && this.ksPkg.level == 0;
            }
            setFiles(files) {
                this.files = files;
            }
            getAllFiles() {
                return pxt.Util.mapMap(this.files, (k, f) => f);
            }
        }
        class Host {
            constructor() {
                this.githubPackageCache = {};
            }
            readFile(module, filename) {
                let epkg = getEditorPkg(module);
                return pxt.U.lookup(epkg.files, filename);
            }
            writeFile(module, filename, contents) {
                const epkg = getEditorPkg(module);
                epkg.files[filename] = contents;
            }
            getHexInfoAsync(extInfo) {
                return pxt.hexloader.getHexInfoAsync(this, extInfo);
            }
            cacheStoreAsync(id, val) {
                return Promise.resolve();
            }
            cacheGetAsync(id) {
                return Promise.resolve(null);
            }
            patchDependencies(cfg, name, repoId) {
                if (!repoId)
                    return false;
                // check that the same package hasn't been added yet
                const repo = pxt.github.parseRepoId(repoId);
                if (!repo)
                    return false;
                for (const k of Object.keys(cfg.dependencies)) {
                    const v = cfg.dependencies[k];
                    const kv = pxt.github.parseRepoId(v);
                    if (kv && repo.fullName == kv.fullName) {
                        if (pxt.semver.strcmp(repo.tag, kv.tag) < 0) {
                            // we have a later tag, use this one
                            cfg.dependencies[k] = repoId;
                        }
                        return true;
                    }
                }
                return false;
            }
            downloadPackageAsync(pkg, dependencies) {
                let proto = pkg.verProtocol();
                let cached = undefined;
                // cache resolve github packages
                if (proto == "github")
                    cached = this.githubPackageCache[pkg._verspec];
                let epkg = getEditorPkg(pkg);
                return (cached ? Promise.resolve(cached) : pkg.commonDownloadAsync())
                    .then(resp => {
                    if (resp) {
                        if (proto == "github" && !cached)
                            this.githubPackageCache[pkg._verspec] = pxt.Util.clone(resp);
                        epkg.setFiles(resp);
                        return Promise.resolve();
                    }
                    if (proto == "empty") {
                        if (Object.keys(epkg.files).length == 0) {
                            epkg.setFiles(emptyPrjFiles());
                        }
                        if (dependencies && dependencies.length) {
                            const files = getEditorPkg(pkg).files;
                            const cfg = JSON.parse(files[pxt.CONFIG_NAME]);
                            dependencies.forEach((d) => {
                                addPackageToConfig(cfg, d);
                            });
                            files[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(cfg);
                        }
                        return Promise.resolve();
                    }
                    else if (proto == "docs") {
                        let files = emptyPrjFiles();
                        let cfg = JSON.parse(files[pxt.CONFIG_NAME]);
                        // load all dependencies
                        pkg.verArgument().split(',').forEach(d => {
                            if (!addPackageToConfig(cfg, d)) {
                                return;
                            }
                        });
                        if (!cfg.yotta)
                            cfg.yotta = {};
                        cfg.yotta.ignoreConflicts = true;
                        files[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(cfg);
                        epkg.setFiles(files);
                        return Promise.resolve();
                    }
                    else if (proto == "invalid") {
                        pxt.log(`skipping invalid pkg ${pkg.id}`);
                        return Promise.resolve();
                    }
                    else {
                        return Promise.reject(`Cannot download ${pkg.version()}; unknown protocol`);
                    }
                });
            }
        }
        let tilemapProject;
        if (!pxt.react.getTilemapProject) {
            pxt.react.getTilemapProject = () => {
                if (!tilemapProject) {
                    tilemapProject = new pxt.TilemapProject();
                    tilemapProject.loadPackage(runner.mainPkg);
                }
                return tilemapProject;
            };
        }
        function addPackageToConfig(cfg, dep) {
            let m = /^([a-zA-Z0-9_-]+)(=(.+))?$/.exec(dep);
            if (m) {
                if (m[3] && this && this.patchDependencies(cfg, m[1], m[3]))
                    return false;
                cfg.dependencies[m[1]] = m[3] || "*";
            }
            else
                console.warn(`unknown package syntax ${dep}`);
            return true;
        }
        function getEditorPkg(p) {
            let r = p._editorPkg;
            if (r)
                return r;
            let top = null;
            if (p != runner.mainPkg)
                top = getEditorPkg(runner.mainPkg);
            let newOne = new EditorPackage(p, top);
            if (p == runner.mainPkg)
                newOne.topPkg = newOne;
            p._editorPkg = newOne;
            return newOne;
        }
        function emptyPrjFiles() {
            let p = pxt.appTarget.tsprj;
            let files = pxt.U.clone(p.files);
            files[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(p.config);
            files[pxt.MAIN_BLOCKS] = "";
            return files;
        }
        function patchSemantic() {
            if ($ && $.fn && $.fn.embed && $.fn.embed.settings && $.fn.embed.settings.sources && $.fn.embed.settings.sources.youtube) {
                $.fn.embed.settings.sources.youtube.url = '//www.youtube.com/embed/{id}?rel=0';
            }
        }
        function initInnerAsync() {
            pxt.setAppTarget(window.pxtTargetBundle);
            pxt.Util.assert(!!pxt.appTarget);
            const href = window.location.href;
            let force = false;
            let lang = undefined;
            if (/[&?]translate=1/.test(href) && !pxt.BrowserUtils.isIE()) {
                lang = ts.pxtc.Util.TRANSLATION_LOCALE;
                force = true;
                pxt.Util.enableLiveLocalizationUpdates();
            }
            else {
                const cookieValue = /PXT_LANG=(.*?)(?:;|$)/.exec(document.cookie);
                const mlang = /(live)?(force)?lang=([a-z]{2,}(-[A-Z]+)?)/i.exec(href);
                lang = mlang ? mlang[3] : (cookieValue && cookieValue[1] || pxt.appTarget.appTheme.defaultLocale || navigator.userLanguage || navigator.language);
                const defLocale = pxt.appTarget.appTheme.defaultLocale;
                const langLowerCase = lang === null || lang === void 0 ? void 0 : lang.toLocaleLowerCase();
                const localDevServe = pxt.BrowserUtils.isLocalHostDev()
                    && (!langLowerCase || (defLocale
                        ? defLocale.toLocaleLowerCase() === langLowerCase
                        : "en" === langLowerCase || "en-us" === langLowerCase));
                const serveLocal = pxt.BrowserUtils.isPxtElectron() || localDevServe;
                const liveTranslationsDisabled = serveLocal || pxt.appTarget.appTheme.disableLiveTranslations;
                if (!liveTranslationsDisabled || !!(mlang === null || mlang === void 0 ? void 0 : mlang[1])) {
                    pxt.Util.enableLiveLocalizationUpdates();
                }
                force = !!mlang && !!mlang[2];
            }
            const versions = pxt.appTarget.versions;
            patchSemantic();
            const cfg = pxt.webConfig;
            return pxt.Util.updateLocalizationAsync({
                targetId: pxt.appTarget.id,
                baseUrl: cfg.commitCdnUrl,
                code: lang,
                pxtBranch: versions ? versions.pxtCrowdinBranch : "",
                targetBranch: versions ? versions.targetCrowdinBranch : "",
                force: force,
            })
                .then(() => {
                runner.mainPkg = new pxt.MainPackage(new Host());
            });
        }
        function initFooter(footer, shareId) {
            if (!footer)
                return;
            let theme = pxt.appTarget.appTheme;
            let body = $('body');
            let $footer = $(footer);
            let footera = $('<a/>').attr('href', theme.homeUrl)
                .attr('target', '_blank');
            $footer.append(footera);
            if (theme.organizationLogo)
                footera.append($('<img/>').attr('src', pxt.Util.toDataUri(theme.organizationLogo)));
            else
                footera.append(lf("powered by {0}", theme.title));
            body.mouseenter(ev => $footer.fadeOut());
            body.mouseleave(ev => $footer.fadeIn());
        }
        runner.initFooter = initFooter;
        function showError(msg) {
            console.error(msg);
        }
        runner.showError = showError;
        let previousMainPackage = undefined;
        function loadPackageAsync(id, code, dependencies) {
            const verspec = id ? /\w+:\w+/.test(id) ? id : "pub:" + id : "empty:tsprj";
            let host;
            let downloadPackagePromise;
            let installPromise;
            if (previousMainPackage && previousMainPackage._verspec == verspec) {
                runner.mainPkg = previousMainPackage;
                host = runner.mainPkg.host();
                downloadPackagePromise = Promise.resolve();
                installPromise = Promise.resolve();
            }
            else {
                host = runner.mainPkg.host();
                runner.mainPkg = new pxt.MainPackage(host);
                runner.mainPkg._verspec = id ? /\w+:\w+/.test(id) ? id : "pub:" + id : "empty:tsprj";
                downloadPackagePromise = host.downloadPackageAsync(runner.mainPkg, dependencies);
                installPromise = runner.mainPkg.installAllAsync();
                // cache previous package
                previousMainPackage = runner.mainPkg;
            }
            return downloadPackagePromise
                .then(() => host.readFile(runner.mainPkg, pxt.CONFIG_NAME))
                .then(str => {
                if (!str)
                    return Promise.resolve();
                return installPromise.then(() => {
                    if (code) {
                        //Set the custom code if provided for docs.
                        let epkg = getEditorPkg(runner.mainPkg);
                        epkg.files[pxt.MAIN_TS] = code;
                        //set the custom doc name from the URL.
                        let cfg = JSON.parse(epkg.files[pxt.CONFIG_NAME]);
                        cfg.name = window.location.href.split('/').pop().split(/[?#]/)[0];
                        ;
                        epkg.files[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(cfg);
                        //Propgate the change to main package
                        runner.mainPkg.config.name = cfg.name;
                        if (runner.mainPkg.config.files.indexOf(pxt.MAIN_BLOCKS) == -1) {
                            runner.mainPkg.config.files.push(pxt.MAIN_BLOCKS);
                        }
                    }
                }).catch(e => {
                    showError(lf("Cannot load extension: {0}", e.message));
                });
            });
        }
        function getCompileOptionsAsync(hex) {
            let trg = runner.mainPkg.getTargetOptions();
            trg.isNative = !!hex;
            trg.hasHex = !!hex;
            return runner.mainPkg.getCompileOptionsAsync(trg);
        }
        function compileAsync(hex, updateOptions) {
            return getCompileOptionsAsync(hex)
                .then(opts => {
                if (updateOptions)
                    updateOptions(opts);
                let resp = pxtc.compile(opts);
                if (resp.diagnostics && resp.diagnostics.length > 0) {
                    resp.diagnostics.forEach(diag => {
                        console.error(diag.messageText);
                    });
                }
                return resp;
            });
        }
        function generateHexFileAsync(options) {
            return loadPackageAsync(options.id)
                .then(() => compileAsync(true, opts => {
                if (options.code)
                    opts.fileSystem[pxt.MAIN_TS] = options.code;
            }))
                .then(resp => {
                if (resp.diagnostics && resp.diagnostics.length > 0) {
                    console.error("Diagnostics", resp.diagnostics);
                }
                return resp.outfiles[pxtc.BINARY_HEX];
            });
        }
        runner.generateHexFileAsync = generateHexFileAsync;
        function generateVMFileAsync(options) {
            pxt.setHwVariant("vm");
            return loadPackageAsync(options.id)
                .then(() => compileAsync(true, opts => {
                if (options.code)
                    opts.fileSystem[pxt.MAIN_TS] = options.code;
            }))
                .then(resp => {
                console.log(resp);
                return resp;
            });
        }
        runner.generateVMFileAsync = generateVMFileAsync;
        async function simulateAsync(container, simOptions) {
            var _a, _b;
            const builtSimJS = simOptions.builtJsInfo || await buildSimJsInfo(simOptions);
            const { js, fnArgs, parts, usedBuiltinParts, } = builtSimJS;
            if (!js) {
                console.error("Program failed to compile");
                return undefined;
            }
            let options = {};
            options.onSimulatorCommand = msg => {
                if (msg.command === "restart") {
                    runOptions.storedState = getStoredState(simOptions.id);
                    driver.run(js, runOptions);
                }
                if (msg.command == "setstate") {
                    if (msg.stateKey && msg.stateValue) {
                        setStoredState(simOptions.id, msg.stateKey, msg.stateValue);
                    }
                }
            };
            options.messageSimulators = (_b = (_a = pxt.appTarget) === null || _a === void 0 ? void 0 : _a.simulator) === null || _b === void 0 ? void 0 : _b.messageSimulators;
            let driver = new pxsim.SimulatorDriver(container, options);
            let board = pxt.appTarget.simulator.boardDefinition;
            let storedState = getStoredState(simOptions.id);
            let runOptions = {
                boardDefinition: board,
                parts: parts,
                builtinParts: usedBuiltinParts,
                fnArgs: fnArgs,
                cdnUrl: pxt.webConfig.commitCdnUrl,
                localizedStrings: pxt.Util.getLocalizedStrings(),
                highContrast: simOptions.highContrast,
                storedState: storedState,
                light: simOptions.light,
                single: simOptions.single
            };
            if (pxt.appTarget.simulator && !simOptions.fullScreen)
                runOptions.aspectRatio = parts.length && pxt.appTarget.simulator.partsAspectRatio
                    ? pxt.appTarget.simulator.partsAspectRatio
                    : pxt.appTarget.simulator.aspectRatio;
            driver.run(js, runOptions);
            return builtSimJS;
        }
        runner.simulateAsync = simulateAsync;
        async function buildSimJsInfo(simOptions) {
            var _a;
            await loadPackageAsync(simOptions.id, simOptions.code, simOptions.dependencies);
            let didUpgrade = false;
            const currentTargetVersion = pxt.appTarget.versions.target;
            let compileResult = await compileAsync(false, opts => {
                var _a;
                if (simOptions.assets) {
                    const parsedAssets = JSON.parse(simOptions.assets);
                    for (const key of Object.keys(parsedAssets)) {
                        const el = parsedAssets[key];
                        opts.fileSystem[key] = el;
                        if (opts.sourceFiles.indexOf(key) < 0) {
                            opts.sourceFiles.push(key);
                        }
                        if (/\.jres$/.test(key)) {
                            const parsedJres = JSON.parse(el);
                            opts.jres = pxt.inflateJRes(parsedJres, opts.jres);
                        }
                    }
                }
                if (simOptions.code)
                    opts.fileSystem[pxt.MAIN_TS] = simOptions.code;
                // Api info needed for py2ts conversion, if project is shared in Python
                if (opts.target.preferredEditor === pxt.PYTHON_PROJECT_NAME) {
                    opts.target.preferredEditor = pxt.JAVASCRIPT_PROJECT_NAME;
                    opts.ast = true;
                    const resp = pxtc.compile(opts);
                    const apis = getApiInfo(resp.ast, opts);
                    opts.apisInfo = apis;
                    opts.target.preferredEditor = pxt.PYTHON_PROJECT_NAME;
                }
                // Apply upgrade rules if necessary
                const sharedTargetVersion = (_a = runner.mainPkg.config.targetVersions) === null || _a === void 0 ? void 0 : _a.target;
                if (sharedTargetVersion && currentTargetVersion &&
                    pxt.semver.cmp(pxt.semver.parse(sharedTargetVersion), pxt.semver.parse(currentTargetVersion)) < 0) {
                    for (const fileName of Object.keys(opts.fileSystem)) {
                        if (!pxt.Util.startsWith(fileName, "pxt_modules") && pxt.Util.endsWith(fileName, ".ts")) {
                            didUpgrade = true;
                            opts.fileSystem[fileName] = pxt.patching.patchJavaScript(sharedTargetVersion, opts.fileSystem[fileName]);
                        }
                    }
                }
            });
            if (((_a = compileResult.diagnostics) === null || _a === void 0 ? void 0 : _a.length) > 0 && didUpgrade) {
                pxt.log("Compile with upgrade rules failed, trying again with original code");
                compileResult = await compileAsync(false, opts => {
                    if (simOptions.code)
                        opts.fileSystem[pxt.MAIN_TS] = simOptions.code;
                });
            }
            if (compileResult.diagnostics && compileResult.diagnostics.length > 0) {
                console.error("Diagnostics", compileResult.diagnostics);
            }
            return pxtc.buildSimJsInfo(compileResult);
        }
        runner.buildSimJsInfo = buildSimJsInfo;
        function getStoredState(id) {
            let storedState = {};
            try {
                let projectStorage = window.localStorage.getItem(id);
                if (projectStorage) {
                    storedState = JSON.parse(projectStorage);
                }
            }
            catch (e) { }
            return storedState;
        }
        function setStoredState(id, key, value) {
            let storedState = getStoredState(id);
            if (!id) {
                return;
            }
            if (value)
                storedState[key] = value;
            else
                delete storedState[key];
            try {
                window.localStorage.setItem(id, JSON.stringify(storedState));
            }
            catch (e) { }
        }
        let LanguageMode;
        (function (LanguageMode) {
            LanguageMode[LanguageMode["Blocks"] = 0] = "Blocks";
            LanguageMode[LanguageMode["TypeScript"] = 1] = "TypeScript";
            LanguageMode[LanguageMode["Python"] = 2] = "Python";
        })(LanguageMode = runner.LanguageMode || (runner.LanguageMode = {}));
        runner.editorLanguageMode = LanguageMode.Blocks;
        function setEditorContextAsync(mode, localeInfo) {
            runner.editorLanguageMode = mode;
            if (localeInfo != pxt.Util.localeInfo()) {
                const localeLiveRx = /^live-/;
                const fetchLive = localeLiveRx.test(localeInfo);
                if (fetchLive) {
                    pxt.Util.enableLiveLocalizationUpdates();
                }
                return pxt.Util.updateLocalizationAsync({
                    targetId: pxt.appTarget.id,
                    baseUrl: pxt.webConfig.commitCdnUrl,
                    code: localeInfo.replace(localeLiveRx, ''),
                    pxtBranch: pxt.appTarget.versions.pxtCrowdinBranch,
                    targetBranch: pxt.appTarget.versions.targetCrowdinBranch,
                });
            }
            return Promise.resolve();
        }
        runner.setEditorContextAsync = setEditorContextAsync;
        function receiveDocMessage(e) {
            let m = e.data;
            if (!m)
                return;
            switch (m.type) {
                case "fileloaded":
                    let fm = m;
                    let name = fm.name;
                    let mode = LanguageMode.Blocks;
                    if (/\.ts$/i.test(name)) {
                        mode = LanguageMode.TypeScript;
                    }
                    else if (/\.py$/i.test(name)) {
                        mode = LanguageMode.Python;
                    }
                    setEditorContextAsync(mode, fm.locale);
                    break;
                case "popout":
                    let mp = /((\/v[0-9+])\/)?[^\/]*#(doc|md):([^&?:]+)/i.exec(window.location.href);
                    if (mp) {
                        const docsUrl = pxt.webConfig.docsUrl || '/--docs';
                        let verPrefix = mp[2] || '';
                        let url = mp[3] == "doc" ? (pxt.webConfig.isStatic ? `/docs${mp[4]}.html` : `${mp[4]}`) : `${docsUrl}?md=${mp[4]}`;
                        // notify parent iframe that we have completed the popout
                        if (window.parent)
                            window.parent.postMessage({
                                type: "opendoc",
                                url: pxt.BrowserUtils.urlJoin(verPrefix, url)
                            }, "*");
                    }
                    break;
                case "localtoken":
                    let dm = m;
                    if (dm && dm.localToken) {
                        pxt.Cloud.localToken = dm.localToken;
                        pendingLocalToken.forEach(p => p());
                        pendingLocalToken = [];
                    }
                    break;
            }
        }
        function startRenderServer() {
            pxt.tickEvent("renderer.ready");
            const jobQueue = [];
            let jobPromise = undefined;
            function consumeQueue() {
                if (jobPromise)
                    return; // other worker already in action
                const msg = jobQueue.shift();
                if (!msg)
                    return; // no more work
                const options = (msg.options || {});
                options.splitSvg = false; // don't split when requesting rendered images
                pxt.tickEvent("renderer.job");
                const isXml = /^\s*<xml/.test(msg.code);
                const doWork = async () => {
                    await pxt.BrowserUtils.loadBlocklyAsync();
                    const result = isXml
                        ? await pxt.runner.compileBlocksAsync(msg.code, options)
                        : await runner.decompileSnippetAsync(msg.code, msg.options);
                    const blocksSvg = result.blocksSvg;
                    const width = blocksSvg.viewBox.baseVal.width;
                    const height = blocksSvg.viewBox.baseVal.height;
                    const res = blocksSvg
                        ? await pxt.blocks.layout.blocklyToSvgAsync(blocksSvg, 0, 0, width, height)
                        : undefined;
                    // try to render to png
                    let png;
                    try {
                        png = res
                            ? await pxt.BrowserUtils.encodeToPngAsync(res.xml, { width, height })
                            : undefined;
                    }
                    catch (e) {
                        console.warn(e);
                    }
                    window.parent.postMessage({
                        source: "makecode",
                        type: "renderblocks",
                        id: msg.id,
                        width: res === null || res === void 0 ? void 0 : res.width,
                        height: res === null || res === void 0 ? void 0 : res.height,
                        svg: res === null || res === void 0 ? void 0 : res.svg,
                        uri: png || (res === null || res === void 0 ? void 0 : res.xml),
                        css: res === null || res === void 0 ? void 0 : res.css
                    }, "*");
                };
                jobPromise = doWork()
                    .catch(e => {
                    window.parent.postMessage({
                        source: "makecode",
                        type: "renderblocks",
                        id: msg.id,
                        error: e.message
                    }, "*");
                })
                    .finally(() => {
                    jobPromise = undefined;
                    consumeQueue();
                });
            }
            pxt.editor.initEditorExtensionsAsync()
                .then(() => {
                // notify parent that render engine is loaded
                window.addEventListener("message", function (ev) {
                    const msg = ev.data;
                    if (msg.type == "renderblocks") {
                        jobQueue.push(msg);
                        consumeQueue();
                    }
                }, false);
                window.parent.postMessage({
                    source: "makecode",
                    type: "renderready",
                    versions: pxt.appTarget.versions
                }, "*");
            });
        }
        runner.startRenderServer = startRenderServer;
        function startDocsServer(loading, content, backButton) {
            pxt.tickEvent("docrenderer.ready");
            const history = [];
            if (backButton) {
                backButton.addEventListener("click", () => {
                    goBack();
                });
                setElementDisabled(backButton, true);
            }
            function render(doctype, src) {
                pxt.debug(`rendering ${doctype}`);
                if (backButton)
                    $(backButton).hide();
                $(content).hide();
                $(loading).show();
                pxt.U.delay(100) // allow UI to update
                    .then(() => {
                    switch (doctype) {
                        case "print":
                            const data = window.localStorage["printjob"];
                            delete window.localStorage["printjob"];
                            return renderProjectFilesAsync(content, JSON.parse(data), undefined, true)
                                .then(() => pxsim.print(1000));
                        case "project":
                            return renderProjectFilesAsync(content, JSON.parse(src))
                                .then(() => pxsim.print(1000));
                        case "projectid":
                            return renderProjectAsync(content, JSON.parse(src))
                                .then(() => pxsim.print(1000));
                        case "doc":
                            return renderDocAsync(content, src);
                        case "book":
                            return renderBookAsync(content, src);
                        default:
                            return renderMarkdownAsync(content, src);
                    }
                })
                    .catch(e => {
                    $(content).html(`
                    <img style="height:4em;" src="${pxt.appTarget.appTheme.docsLogo}" />
                    <h1>${lf("Oops")}</h1>
                    <h3>${lf("We could not load the documentation, please check your internet connection.")}</h3>
                    <button class="ui button primary" id="tryagain">${lf("Try Again")}</button>`);
                    $(content).find('#tryagain').click(() => {
                        render(doctype, src);
                    });
                    // notify parent iframe that docs weren't loaded
                    if (window.parent)
                        window.parent.postMessage({
                            type: "docfailed",
                            docType: doctype,
                            src: src
                        }, "*");
                }).finally(() => {
                    $(loading).hide();
                    if (backButton)
                        $(backButton).show();
                    $(content).show();
                })
                    .then(() => { });
            }
            function pushHistory() {
                if (!backButton)
                    return;
                history.push(window.location.hash);
                if (history.length > 10) {
                    history.shift();
                }
                if (history.length > 1) {
                    setElementDisabled(backButton, false);
                }
            }
            function goBack() {
                if (!backButton)
                    return;
                if (history.length > 1) {
                    // Top is current page
                    history.pop();
                    window.location.hash = history.pop();
                }
                if (history.length <= 1) {
                    setElementDisabled(backButton, true);
                }
            }
            function setElementDisabled(el, disabled) {
                if (disabled) {
                    pxsim.U.addClass(el, "disabled");
                    el.setAttribute("aria-disabled", "true");
                }
                else {
                    pxsim.U.removeClass(el, "disabled");
                    el.setAttribute("aria-disabled", "false");
                }
            }
            async function renderHashAsync() {
                let m = /^#(doc|md|tutorial|book|project|projectid|print):([^&?:]+)(:([^&?:]+):([^&?:]+))?/i.exec(window.location.hash);
                if (m) {
                    pushHistory();
                    if (m[4]) {
                        let mode = LanguageMode.TypeScript;
                        if (/^blocks$/i.test(m[4])) {
                            mode = LanguageMode.Blocks;
                        }
                        else if (/^python$/i.test(m[4])) {
                            mode = LanguageMode.Python;
                        }
                        await setEditorContextAsync(mode, m[5]);
                    }
                    // navigation occured
                    render(m[1], decodeURIComponent(m[2]));
                }
            }
            let promise = pxt.editor.initEditorExtensionsAsync();
            promise.then(() => {
                window.addEventListener("message", receiveDocMessage, false);
                window.addEventListener("hashchange", () => {
                    renderHashAsync();
                }, false);
                parent.postMessage({ type: "sidedocready" }, "*");
                // delay load doc page to allow simulator to load first
                setTimeout(() => renderHashAsync(), 1);
            });
        }
        runner.startDocsServer = startDocsServer;
        function renderProjectAsync(content, projectid) {
            return pxt.Cloud.privateGetTextAsync(projectid + "/text")
                .then(txt => JSON.parse(txt))
                .then(files => renderProjectFilesAsync(content, files, projectid));
        }
        runner.renderProjectAsync = renderProjectAsync;
        function renderProjectFilesAsync(content, files, projectid = null, escapeLinks = false) {
            const cfg = (JSON.parse(files[pxt.CONFIG_NAME]) || {});
            let md = `# ${cfg.name} ${cfg.version ? cfg.version : ''}

`;
            const readme = "README.md";
            if (files[readme])
                md += files[readme].replace(/^#+/, "$0#") + '\n'; // bump all headers down 1
            cfg.files.filter(f => f != pxt.CONFIG_NAME && f != readme)
                .filter(f => matchesLanguageMode(f, runner.editorLanguageMode))
                .forEach(f => {
                if (!/^main\.(ts|blocks)$/.test(f))
                    md += `
## ${f}
`;
                if (/\.ts$/.test(f)) {
                    md += `\`\`\`typescript
${files[f]}
\`\`\`
`;
                }
                else if (/\.blocks?$/.test(f)) {
                    md += `\`\`\`blocksxml
${files[f]}
\`\`\`
`;
                }
                else {
                    md += `\`\`\`${f.substr(f.indexOf('.'))}
${files[f]}
\`\`\`
`;
                }
            });
            const deps = cfg && cfg.dependencies && Object.keys(cfg.dependencies).filter(k => k != pxt.appTarget.corepkg);
            if (deps && deps.length) {
                md += `
## ${lf("Extensions")} #extensions

${deps.map(k => `* ${k}, ${cfg.dependencies[k]}`).join('\n')}

\`\`\`package
${deps.map(k => `${k}=${cfg.dependencies[k]}`).join('\n')}
\`\`\`
`;
            }
            if (projectid) {
                let linkString = (pxt.appTarget.appTheme.shareUrl || "https://makecode.com/") + projectid;
                if (escapeLinks) {
                    // If printing the link will show up twice if it's an actual link
                    linkString = "`" + linkString + "`";
                }
                md += `
${linkString}

`;
            }
            console.debug(`print md: ${md}`);
            const options = {
                print: true
            };
            return renderMarkdownAsync(content, md, options);
        }
        runner.renderProjectFilesAsync = renderProjectFilesAsync;
        function matchesLanguageMode(filename, mode) {
            switch (mode) {
                case LanguageMode.Blocks:
                    return /\.blocks?$/.test(filename);
                case LanguageMode.TypeScript:
                    return /\.ts?$/.test(filename);
                case LanguageMode.Python:
                    return /\.py?$/.test(filename);
            }
        }
        function renderDocAsync(content, docid) {
            docid = docid.replace(/^\//, "");
            return pxt.Cloud.markdownAsync(docid)
                .then(md => renderMarkdownAsync(content, md, { path: docid }));
        }
        function renderBookAsync(content, summaryid) {
            summaryid = summaryid.replace(/^\//, "");
            pxt.tickEvent('book', { id: summaryid });
            pxt.log(`rendering book from ${summaryid}`);
            // display loader
            const $loader = $("#loading").find(".loader");
            $loader.addClass("text").text(lf("Compiling your book (this may take a minute)"));
            // start the work
            let toc;
            return pxt.U.delay(100)
                .then(() => pxt.Cloud.markdownAsync(summaryid))
                .then(summary => {
                toc = pxt.docs.buildTOC(summary);
                pxt.log(`TOC: ${JSON.stringify(toc, null, 2)}`);
                const tocsp = [];
                pxt.docs.visitTOC(toc, entry => {
                    if (/^\//.test(entry.path) && !/^\/pkg\//.test(entry.path))
                        tocsp.push(entry);
                });
                return pxt.U.promisePoolAsync(4, tocsp, async (entry) => {
                    try {
                        const md = await pxt.Cloud.markdownAsync(entry.path);
                        entry.markdown = md;
                    }
                    catch (e) {
                        entry.markdown = `_${entry.path} failed to load._`;
                    }
                });
            })
                .then(pages => {
                let md = toc[0].name;
                pxt.docs.visitTOC(toc, entry => {
                    if (entry.markdown)
                        md += '\n\n' + entry.markdown;
                });
                return renderMarkdownAsync(content, md);
            });
        }
        const template = `
<aside id=button class=box>
   <a class="ui primary button" href="@ARGS@">@BODY@</a>
</aside>

<aside id=vimeo>
<div class="ui two column stackable grid container">
<div class="column">
    <div class="ui embed mdvid" data-source="vimeo" data-id="@ARGS@" data-placeholder="/thumbnail/1024/vimeo/@ARGS@" data-icon="video play">
    </div>
</div></div>
</aside>

<aside id=youtube>
<div class="ui two column stackable grid container">
<div class="column">
    <div class="ui embed mdvid" data-source="youtube" data-id="@ARGS@" data-placeholder="https://img.youtube.com/vi/@ARGS@/0.jpg">
    </div>
</div></div>
</aside>

<aside id=section>
    <!-- section @ARGS@ -->
</aside>

<aside id=hide class=box>
    <div style='display:none'>
        @BODY@
    </div>
</aside>

<aside id=avatar class=box>
    <div class='avatar @ARGS@'>
        <div class='avatar-image'></div>
        <div class='ui compact message'>
            @BODY@
        </div>
    </div>
</aside>

<aside id=hint class=box>
    <div class="ui info message">
        <div class="content">
            @BODY@
        </div>
    </div>
</aside>

<aside id=codecard class=box>
    <pre><code class="lang-codecard">@BODY@</code></pre>
</aside>

<aside id=tutorialhint class=box>
    <div class="ui hint message">
        <div class="content">
            @BODY@
        </div>
    </div>
</aside>

<aside id=reminder class=box>
    <div class="ui warning message">
        <div class="content">
            @BODY@
        </div>
    </div>
</aside>

<aside id=alert class=box>
    <div class="ui negative message">
        <div class="content">
            @BODY@
        </div>
    </div>
</aside>

<aside id=tip class=box>
    <div class="ui positive message">
        <div class="content">
            @BODY@
        </div>
    </div>
</aside>

<!-- wrapped around ordinary content -->
<aside id=main-container class=box>
    <div class="ui text">
        @BODY@
    </div>
</aside>

<!-- used for 'column' box - they are collected and wrapped in 'column-container' -->
<aside id=column class=aside>
    <div class='column'>
        @BODY@
    </div>
</aside>
<aside id=column-container class=box>
    <div class="ui three column stackable grid text">
        @BODY@
    </div>
</aside>
@breadcrumb@
@body@`;
        function renderMarkdownAsync(content, md, options = {}) {
            const html = pxt.docs.renderMarkdown({
                template: template,
                markdown: md,
                theme: pxt.appTarget.appTheme
            });
            let blocksAspectRatio = options.blocksAspectRatio
                || window.innerHeight < window.innerWidth ? 1.62 : 1 / 1.62;
            $(content).html(html);
            $(content).find('a').attr('target', '_blank');
            const renderOptions = pxt.runner.defaultClientRenderOptions();
            renderOptions.tutorial = !!options.tutorial;
            renderOptions.blocksAspectRatio = blocksAspectRatio || renderOptions.blocksAspectRatio;
            renderOptions.showJavaScript = runner.editorLanguageMode == LanguageMode.TypeScript;
            if (options.print) {
                renderOptions.showEdit = false;
                renderOptions.simulator = false;
            }
            return pxt.runner.renderAsync(renderOptions).then(() => {
                // patch a elements
                $(content).find('a[href^="/"]').removeAttr('target').each((i, a) => {
                    $(a).attr('href', '#doc:' + $(a).attr('href').replace(/^\//, ''));
                });
                // enable embeds
                $(content).find('.ui.embed').embed();
            });
        }
        runner.renderMarkdownAsync = renderMarkdownAsync;
        let programCache;
        let apiCache;
        function decompileSnippetAsync(code, options) {
            const { assets, forceCompilation, snippetMode, generateSourceMap } = options || {};
            // code may be undefined or empty!!!
            const packageid = options && options.packageId ? "pub:" + options.packageId :
                options && options.package ? "docs:" + options.package
                    : null;
            return loadPackageAsync(packageid, code)
                .then(() => getCompileOptionsAsync(pxt.appTarget.compile ? pxt.appTarget.compile.hasHex : false))
                .then(opts => {
                // compile
                if (code)
                    opts.fileSystem[pxt.MAIN_TS] = code;
                opts.ast = true;
                if (assets) {
                    for (const key of Object.keys(assets)) {
                        if (opts.sourceFiles.indexOf(key) < 0) {
                            opts.sourceFiles.push(key);
                        }
                        opts.fileSystem[key] = assets[key];
                    }
                }
                let compileJS = undefined;
                let program;
                if (forceCompilation) {
                    compileJS = pxtc.compile(opts);
                    program = compileJS && compileJS.ast;
                }
                else {
                    program = pxtc.getTSProgram(opts, programCache);
                }
                programCache = program;
                // decompile to python
                let compilePython = undefined;
                if (pxt.appTarget.appTheme.python) {
                    compilePython = ts.pxtc.transpile.tsToPy(program, pxt.MAIN_TS);
                }
                // decompile to blocks
                let apis = getApiInfo(program, opts);
                return ts.pxtc.localizeApisAsync(apis, runner.mainPkg)
                    .then(() => {
                    let blocksInfo = pxtc.getBlocksInfo(apis);
                    pxt.blocks.initializeAndInject(blocksInfo);
                    const tilemapJres = assets === null || assets === void 0 ? void 0 : assets[pxt.TILEMAP_JRES];
                    const assetsJres = assets === null || assets === void 0 ? void 0 : assets[pxt.IMAGES_JRES];
                    if (tilemapJres || assetsJres) {
                        tilemapProject = new pxt.TilemapProject();
                        tilemapProject.loadPackage(runner.mainPkg);
                        if (tilemapJres)
                            tilemapProject.loadTilemapJRes(JSON.parse(tilemapJres), true);
                        if (assetsJres)
                            tilemapProject.loadAssetsJRes(JSON.parse(assetsJres));
                    }
                    let bresp = pxtc.decompiler.decompileToBlocks(blocksInfo, program.getSourceFile(pxt.MAIN_TS), {
                        snippetMode,
                        generateSourceMap
                    });
                    if (bresp.diagnostics && bresp.diagnostics.length > 0)
                        bresp.diagnostics.forEach(diag => console.error(diag.messageText));
                    if (!bresp.success)
                        return {
                            package: runner.mainPkg,
                            compileProgram: program,
                            compileJS,
                            compileBlocks: bresp,
                            apiInfo: apis
                        };
                    pxt.debug(bresp.outfiles[pxt.MAIN_BLOCKS]);
                    const blocksSvg = pxt.blocks.render(bresp.outfiles[pxt.MAIN_BLOCKS], options);
                    if (tilemapJres || assetsJres) {
                        tilemapProject = null;
                    }
                    return {
                        package: runner.mainPkg,
                        compileProgram: program,
                        compileJS,
                        compileBlocks: bresp,
                        compilePython,
                        apiInfo: apis,
                        blocksSvg
                    };
                });
            });
        }
        runner.decompileSnippetAsync = decompileSnippetAsync;
        function getApiInfo(program, opts) {
            if (!apiCache)
                apiCache = {};
            const key = Object.keys(opts.fileSystem).sort().join(";");
            if (!apiCache[key])
                apiCache[key] = pxtc.getApiInfo(program, opts.jres);
            return apiCache[key];
        }
        function compileBlocksAsync(code, options) {
            const { assets } = options || {};
            const packageid = options && options.packageId ? "pub:" + options.packageId :
                options && options.package ? "docs:" + options.package
                    : null;
            return loadPackageAsync(packageid, "")
                .then(() => getCompileOptionsAsync(pxt.appTarget.compile ? pxt.appTarget.compile.hasHex : false))
                .then(opts => {
                opts.ast = true;
                if (assets) {
                    for (const key of Object.keys(assets)) {
                        if (opts.sourceFiles.indexOf(key) < 0) {
                            opts.sourceFiles.push(key);
                        }
                        opts.fileSystem[key] = assets[key];
                    }
                }
                const resp = pxtc.compile(opts);
                const apis = getApiInfo(resp.ast, opts);
                return ts.pxtc.localizeApisAsync(apis, runner.mainPkg)
                    .then(() => {
                    const blocksInfo = pxtc.getBlocksInfo(apis);
                    pxt.blocks.initializeAndInject(blocksInfo);
                    const tilemapJres = assets === null || assets === void 0 ? void 0 : assets[pxt.TILEMAP_JRES];
                    const assetsJres = assets === null || assets === void 0 ? void 0 : assets[pxt.IMAGES_JRES];
                    if (tilemapJres || assetsJres) {
                        tilemapProject = new pxt.TilemapProject();
                        tilemapProject.loadPackage(runner.mainPkg);
                        if (tilemapJres)
                            tilemapProject.loadTilemapJRes(JSON.parse(tilemapJres), true);
                        if (assetsJres)
                            tilemapProject.loadAssetsJRes(JSON.parse(assetsJres));
                    }
                    const blockSvg = pxt.blocks.render(code, options);
                    if (tilemapJres || assetsJres) {
                        tilemapProject = null;
                    }
                    return {
                        package: runner.mainPkg,
                        blocksSvg: blockSvg,
                        apiInfo: apis
                    };
                });
            });
        }
        runner.compileBlocksAsync = compileBlocksAsync;
        let pendingLocalToken = [];
        function waitForLocalTokenAsync() {
            if (pxt.Cloud.localToken) {
                return Promise.resolve();
            }
            return new Promise((resolve, reject) => {
                pendingLocalToken.push(resolve);
            });
        }
        runner.initCallbacks = [];
        function init() {
            initInnerAsync()
                .then(() => {
                for (let i = 0; i < runner.initCallbacks.length; ++i) {
                    runner.initCallbacks[i]();
                }
            });
        }
        runner.init = init;
        function windowLoad() {
            let f = window.ksRunnerWhenLoaded;
            if (f)
                f();
        }
        windowLoad();
    })(runner = pxt.runner || (pxt.runner = {}));
})(pxt || (pxt = {}));
