var pxt;
(function (pxt) {
    let callbacks;
    let ghSetup = false;
    class CachedGithubDb {
        constructor(db) {
            this.db = db;
        }
        loadAsync(repopath, tag, suffix, loader) {
            // only cache releases
            if (!/^v\d+\.\d+\.\d+$/.test(tag))
                return loader(repopath, tag);
            const key = `gh-${suffix}-${repopath}#${tag}`;
            return callbacks.cacheGet(key)
                .then(json => {
                if (json) {
                    const p = pxt.Util.jsonTryParse(json);
                    if (p) {
                        pxt.debug(`cache hit ${key}`);
                        return Promise.resolve(p);
                    }
                }
                // download and cache
                return loader(repopath, tag)
                    .then(p => {
                    if (p) {
                        pxt.debug(`cached ${key}`);
                        return callbacks.cacheSet(key, JSON.stringify(p))
                            .then(() => p);
                    }
                    return p;
                });
            });
        }
        latestVersionAsync(repopath, config) {
            return this.db.latestVersionAsync(repopath, config);
        }
        loadConfigAsync(repopath, tag) {
            return this.loadAsync(repopath, tag, "pxt", (r, t) => this.db.loadConfigAsync(r, t));
        }
        loadPackageAsync(repopath, tag) {
            return this.loadAsync(repopath, tag, "pkg", (r, t) => this.db.loadPackageAsync(r, t));
        }
    }
    function pkgOverrideAsync(pkg) {
        const f = callbacks === null || callbacks === void 0 ? void 0 : callbacks.pkgOverrideAsync;
        const v = f ? f(pkg.id) : Promise.resolve(undefined);
        return v.then(r => r ? r : pkg.commonDownloadAsync());
    }
    class SimpleHost {
        constructor(packageFiles) {
            this.packageFiles = packageFiles;
        }
        resolve(module, filename) {
            return "";
        }
        readFile(module, filename) {
            const fid = module.id == "this" ? filename :
                "pxt_modules/" + module.id + "/" + filename;
            if (this.packageFiles[fid] !== undefined) {
                return this.packageFiles[fid];
            }
            else if (pxt.appTarget.bundledpkgs[module.id]) {
                return pxt.appTarget.bundledpkgs[module.id][filename];
            }
            else {
                return null;
            }
        }
        writeFile(module, filename, contents) {
            const pref = module.id == "this" ? "" : "pxt_modules/" + module.id + "/";
            pxt.debug(`write file ${pref + filename}`);
            this.packageFiles[pref + filename] = contents;
        }
        getHexInfoAsync(extInfo) {
            //console.log(`getHexInfoAsync(${extInfo})`);
            return Promise.resolve({ hex: ["SKIP"] });
        }
        cacheStoreAsync(id, val) {
            //console.log(`cacheStoreAsync(${id}, ${val})`)
            if (callbacks === null || callbacks === void 0 ? void 0 : callbacks.cacheSet)
                return callbacks.cacheSet(id, val);
            return Promise.resolve();
        }
        cacheGetAsync(id) {
            //console.log(`cacheGetAsync(${id})`)
            if (callbacks === null || callbacks === void 0 ? void 0 : callbacks.cacheGet)
                return callbacks.cacheGet(id);
            return Promise.resolve("");
        }
        downloadPackageAsync(pkg) {
            if (ghSetup)
                return pkgOverrideAsync(pkg)
                    .then(resp => {
                    if (resp) {
                        pxt.U.iterMap(resp, (fn, cont) => {
                            this.writeFile(pkg, fn, cont);
                        });
                    }
                });
            //console.log(`downloadPackageAsync(${pkg.id})`)
            return Promise.resolve();
        }
        resolveVersionAsync(pkg) {
            //console.log(`resolveVersionAsync(${pkg.id})`)
            return Promise.resolve("*");
        }
    }
    pxt.SimpleHost = SimpleHost;
    function prepPythonOptions(opts) {
        // this is suboptimal, but we need apisInfo for the python converter
        if (opts.target.preferredEditor == pxt.PYTHON_PROJECT_NAME) {
            const opts2 = pxt.U.clone(opts);
            opts2.ast = true;
            opts2.target.preferredEditor = pxt.JAVASCRIPT_PROJECT_NAME;
            //opts2.noEmit = true
            // remove previously converted .ts files, so they don't end up in apisinfo
            for (let f of opts2.sourceFiles) {
                if (pxt.U.endsWith(f, ".py"))
                    opts2.fileSystem[f.slice(0, -3) + ".ts"] = " ";
            }
            const res = pxtc.compile(opts2);
            opts.apisInfo = pxtc.getApiInfo(res.ast, opts2.jres);
        }
    }
    pxt.prepPythonOptions = prepPythonOptions;
    function simpleInstallPackagesAsync(files) {
        const host = new SimpleHost(files);
        const mainPkg = new pxt.MainPackage(host);
        return mainPkg.loadAsync(true);
    }
    pxt.simpleInstallPackagesAsync = simpleInstallPackagesAsync;
    function simpleGetCompileOptionsAsync(files, simpleOptions) {
        const host = new SimpleHost(files);
        const mainPkg = new pxt.MainPackage(host);
        return mainPkg.loadAsync()
            .then(() => {
            let target = mainPkg.getTargetOptions();
            if (target.hasHex)
                target.isNative = simpleOptions.native;
            return mainPkg.getCompileOptionsAsync(target);
        }).then(opts => {
            patchTS(mainPkg.targetVersion(), opts);
            prepPythonOptions(opts);
            return opts;
        });
    }
    pxt.simpleGetCompileOptionsAsync = simpleGetCompileOptionsAsync;
    function simpleCompileAsync(files, optionsOrNative) {
        const options = typeof optionsOrNative == "boolean" ? { native: optionsOrNative }
            : optionsOrNative || {};
        return simpleGetCompileOptionsAsync(files, options)
            .then(opts => pxtc.compile(opts))
            .then((r) => {
            if (!r.success)
                r.errors = r.diagnostics.map(ts.pxtc.getDiagnosticString).join("") || "Unknown error.";
            return r;
        });
    }
    pxt.simpleCompileAsync = simpleCompileAsync;
    function patchTS(version, opts) {
        if (!version)
            return;
        pxt.debug(`applying TS patches relative to ${version}`);
        for (let fn of Object.keys(opts.fileSystem)) {
            if (fn.indexOf("/") == -1 && pxt.U.endsWith(fn, ".ts")) {
                const ts = opts.fileSystem[fn];
                const ts2 = pxt.patching.patchJavaScript(version, ts);
                if (ts != ts2) {
                    pxt.debug(`applying TS patch to ${fn}`);
                    opts.fileSystem[fn] = ts2;
                }
            }
        }
    }
    pxt.patchTS = patchTS;
    function setupSimpleCompile(cfg) {
        if (typeof global != "undefined" && !global.btoa) {
            global.btoa = function (str) { return Buffer.from(str, "binary").toString("base64"); };
            global.atob = function (str) { return Buffer.from(str, "base64").toString("binary"); };
        }
        if (typeof pxtTargetBundle != "undefined") {
            pxt.debug("setup app bundle");
            pxt.setAppTarget(pxtTargetBundle);
        }
        if (cfg) {
            callbacks = cfg;
            ghSetup = true;
            if (cfg.httpRequestAsync)
                pxt.Util.httpRequestCoreAsync = cfg.httpRequestAsync;
            pxt.github.forceProxy = true;
            pxt.github.db = new CachedGithubDb(new pxt.github.MemoryGithubDb());
        }
        pxt.debug("simple setup done");
    }
    pxt.setupSimpleCompile = setupSimpleCompile;
})(pxt || (pxt = {}));
/// <reference path='../built/pxtlib.d.ts' />
var pxt;
(function (pxt) {
    function simshim(prog, pathParse) {
        let SK = ts.SyntaxKind;
        let checker = prog.getTypeChecker();
        let mainWr = pxt.cpp.nsWriter("declare namespace");
        let currNs = "";
        let currMod;
        for (let src of prog.getSourceFiles()) {
            if (pathParse) {
                let pp = pathParse(src.fileName);
                pxt.debug("SimShim[1]: " + pp.dir);
                if (!pxt.U.endsWith(pp.dir, "/sim") && !pxt.U.startsWith(src.fileName, "sim/"))
                    continue;
            }
            else if (!pxt.U.startsWith(src.fileName, "sim/"))
                continue;
            pxt.debug("SimShim[2]: " + src.fileName);
            for (let stmt of src.statements) {
                let mod = stmt;
                if (stmt.kind == SK.ModuleDeclaration && mod.name.text == "pxsim") {
                    currMod = mod;
                    doStmt(mod.body);
                }
            }
        }
        let res = {};
        res[pxt.appTarget.corepkg] = mainWr.finish();
        return res;
        function typeOf(node) {
            let r;
            if (ts.isExpression(node))
                r = checker.getContextualType(node);
            if (!r)
                r = checker.getTypeAtLocation(node);
            return r;
        }
        /*
        let doSymbol = (sym: ts.Symbol) => {
            if (sym.getFlags() & ts.SymbolFlags.HasExports) {
                typechecker.getExportsOfModule(sym).forEach(doSymbol)
            }
            decls[pxtc.getFullName(typechecker, sym)] = sym
        }
        */
        function emitModuleDeclaration(mod) {
            let prevNs = currNs;
            if (currNs)
                currNs += ".";
            currNs += mod.name.text;
            doStmt(mod.body);
            currNs = prevNs;
        }
        function mapType(tp) {
            let fn = checker.typeToString(tp, currMod, ts.TypeFormatFlags.UseFullyQualifiedType);
            fn = fn.replace(/^pxsim\./, "");
            switch (fn) {
                case "RefAction": return "() => void";
                case "RefBuffer": return "Buffer";
                default:
                    return fn;
            }
        }
        function promiseElementType(tp) {
            if (pxtc.isObjectType(tp) && (tp.objectFlags & ts.ObjectFlags.Reference) && tp.symbol.name == "Promise") {
                return tp.typeArguments[0];
            }
            return null;
        }
        function emitClassDeclaration(cl) {
            let cmts = getExportComments(cl);
            if (!cmts)
                return;
            mainWr.setNs(currNs);
            mainWr.write(cmts);
            let prevNs = currNs;
            if (currNs)
                currNs += ".";
            currNs += cl.name.text;
            let decl = prevNs ? "" : "declare";
            let ext = "";
            if (cl.heritageClauses)
                for (let h of cl.heritageClauses) {
                    if (h.token == SK.ExtendsKeyword) {
                        ext = " extends " + mapType(typeOf(h.types[0]));
                    }
                }
            mainWr.write(`${decl} class ${cl.name.text}${ext} {`);
            mainWr.incrIndent();
            for (let mem of cl.members) {
                switch (mem.kind) {
                    case SK.MethodDeclaration:
                        emitFunctionDeclaration(mem);
                        break;
                    case SK.PropertyDeclaration:
                        emitPropertyDeclaration(mem);
                        break;
                    case SK.Constructor:
                        emitConstructorDeclaration(mem);
                        break;
                    case SK.GetAccessor:
                        let hasSetter = cl.members.some(m => m.kind == SK.SetAccessor && m.name.getText() == mem.name.getText());
                        emitFunctionDeclaration(mem, hasSetter);
                        break;
                    default:
                        break;
                }
            }
            currNs = prevNs;
            mainWr.decrIndent();
            mainWr.write(`}`);
        }
        function getExportComments(n) {
            let cmts = pxtc.getComments(n);
            if (!/^\s*\/\/%/m.test(cmts))
                return null;
            return cmts;
        }
        function emitPropertyDeclaration(fn) {
            let cmts = getExportComments(fn);
            if (!cmts)
                return;
            let nm = fn.name.getText();
            let attrs = "//% shim=." + nm;
            let tp = checker.getTypeAtLocation(fn);
            mainWr.write(cmts);
            mainWr.write(attrs);
            mainWr.write(`public ${nm}: ${mapType(tp)};`);
            mainWr.write("");
        }
        function emitConstructorDeclaration(fn) {
            let cmts = getExportComments(fn);
            if (!cmts)
                return;
            let tp = checker.getTypeAtLocation(fn);
            let args = fn.parameters.map(p => p.name.getText() + ": " + mapType(typeOf(p)));
            mainWr.write(cmts);
            mainWr.write(`//% shim="new ${currNs}"`);
            mainWr.write(`constructor(${args.join(", ")});`);
            mainWr.write("");
        }
        function emitFunctionDeclaration(fn, hasSetter = false) {
            let cmts = getExportComments(fn);
            if (!cmts)
                return;
            let fnname = fn.name.getText();
            let isMethod = fn.kind == SK.MethodDeclaration || fn.kind == SK.GetAccessor || fn.kind == SK.SetAccessor;
            let attrs = "//% shim=" + (isMethod ? "." + fnname : currNs + "::" + fnname);
            let sig = checker.getSignatureFromDeclaration(fn);
            let rettp = checker.getReturnTypeOfSignature(sig);
            let asyncName = /Async$/.test(fnname);
            let prom = promiseElementType(rettp);
            if (prom) {
                attrs += " promise";
                rettp = prom;
                if (!asyncName)
                    pxt.U.userError(`${currNs}::${fnname} should be called ${fnname}Async`);
            }
            else if (asyncName) {
                pxt.U.userError(`${currNs}::${fnname} doesn't return a promise`);
            }
            pxt.debug("emitFun: " + fnname);
            let args = fn.parameters.map(p => {
                return `${p.name.getText()}${p.questionToken ? "?" : ""}: ${mapType(typeOf(p))}`;
            });
            let localname = fnname.replace(/Async$/, "");
            let defkw = isMethod ? "public" : "function";
            let allArgs = `(${args.join(", ")})`;
            if (fn.kind == SK.GetAccessor) {
                defkw = hasSetter ? "public" : "readonly";
                allArgs = "";
                attrs += " property";
            }
            if (!isMethod)
                mainWr.setNs(currNs);
            mainWr.write(cmts);
            mainWr.write(attrs);
            mainWr.write(`${defkw} ${localname}${allArgs}: ${mapType(rettp)};`);
            mainWr.write("");
        }
        function doStmt(stmt) {
            switch (stmt.kind) {
                case SK.ModuleDeclaration:
                    return emitModuleDeclaration(stmt);
                case SK.ModuleBlock:
                    return stmt.statements.forEach(doStmt);
                case SK.FunctionDeclaration:
                    return emitFunctionDeclaration(stmt);
                case SK.ClassDeclaration:
                    return emitClassDeclaration(stmt);
            }
            //console.log("SKIP", pxtc.stringKind(stmt))
            //let mod = stmt as ts.ModuleDeclaration
            //if (mod.name) console.log(mod.name.text)
            /*
            if (mod.name) {
                let sym = typechecker.getSymbolAtLocation(mod.name)
                if (sym) doSymbol(sym)
            }
            */
        }
    }
    pxt.simshim = simshim;
})(pxt || (pxt = {}));
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        /**
         * Traverses the AST and injects information about function calls into the expression
         * nodes. The decompiler consumes this information later
         *
         * @param program The TypeScript Program representing the code to compile
         * @param entryPoint The name of the source file to annotate the AST of
         * @param compileTarget The compilation of the target
         */
        function annotate(program, entryPoint, compileTarget) {
            const oldTarget = pxtc.target;
            pxtc.target = compileTarget;
            let src = program.getSourceFiles().filter(f => f.fileName === entryPoint)[0];
            let checker = program.getTypeChecker();
            recurse(src);
            pxtc.target = oldTarget;
            function recurse(parent) {
                ts.forEachChild(parent, child => {
                    switch (child.kind) {
                        case ts.SyntaxKind.CallExpression:
                            mkCallInfo(child, child.arguments.slice(0), null, getDecl(child.expression));
                            break;
                        case ts.SyntaxKind.PropertyAccessExpression:
                            mkCallInfo(child, []);
                            break;
                        case ts.SyntaxKind.TaggedTemplateExpression:
                            mkCallInfo(child, [child.template], true, getDecl(child.tag));
                            break;
                        case ts.SyntaxKind.BinaryExpression:
                            annotateBinaryExpression(child);
                            break;
                        case ts.SyntaxKind.Identifier:
                            const decl = getDecl(child);
                            if (decl && decl.getSourceFile().fileName !== pxt.MAIN_TS && decl.kind == ts.SyntaxKind.VariableDeclaration) {
                                const info = pxtc.pxtInfo(child);
                                info.flags |= 4 /* IsGlobalIdentifier */;
                                if (!info.commentAttrs) {
                                    info.commentAttrs = pxtc.parseComments(decl);
                                }
                            }
                            break;
                    }
                    recurse(child);
                });
            }
            function annotateBinaryExpression(node) {
                const trg = node.left;
                const expr = node.right;
                let lt = typeOf(node.left);
                let rt = typeOf(node.right);
                if (node.operatorToken.kind == pxtc.SK.PlusToken || node.operatorToken.kind == pxtc.SK.PlusEqualsToken) {
                    if (pxtc.isStringType(lt) || (pxtc.isStringType(rt) && node.operatorToken.kind == pxtc.SK.PlusToken)) {
                        pxtc.pxtInfo(node).exprInfo = {
                            leftType: checker.typeToString(lt),
                            rightType: checker.typeToString(rt)
                        };
                    }
                }
                switch (node.operatorToken.kind) {
                    case ts.SyntaxKind.EqualsToken:
                    case ts.SyntaxKind.PlusEqualsToken:
                    case ts.SyntaxKind.MinusEqualsToken:
                        if (trg.kind == pxtc.SK.PropertyAccessExpression) {
                            // Getter/Setter
                            let decl = getDecl(trg);
                            if (decl && decl.kind == pxtc.SK.GetAccessor) {
                                decl = ts.getDeclarationOfKind(decl.symbol, pxtc.SK.SetAccessor);
                                mkCallInfo(trg, [expr], false, decl);
                            }
                            else if (decl && (decl.kind == pxtc.SK.PropertySignature || decl.kind == pxtc.SK.PropertyAssignment || (pxtc.target && pxtc.target.switches.slowFields))) {
                                mkCallInfo(trg, [expr]);
                            }
                        }
                        break;
                }
            }
            function mkCallInfo(node, args, isExpression = false, d = null) {
                let hasRet = isExpression || !(typeOf(node).flags & ts.TypeFlags.Void);
                let decl = d || getDecl(node);
                if (node.expression && decl) {
                    let isMethod = false;
                    switch (decl.kind) {
                        // we treat properties via calls
                        // so we say they are "methods"
                        case pxtc.SK.PropertySignature:
                        case pxtc.SK.PropertyAssignment:
                        case pxtc.SK.PropertyDeclaration:
                            if (!pxtc.isStatic(decl)) {
                                isMethod = true;
                            }
                            break;
                        case pxtc.SK.Parameter:
                            if (pxtc.isCtorField(decl)) {
                                isMethod = true;
                            }
                            break;
                        // TOTO case: case SK.ShorthandPropertyAssignment
                        // these are the real methods
                        case pxtc.SK.GetAccessor:
                        case pxtc.SK.SetAccessor:
                        case pxtc.SK.MethodDeclaration:
                        case pxtc.SK.MethodSignature:
                            isMethod = true;
                            break;
                        default:
                            break;
                    }
                    if (isMethod) {
                        const expr = node.expression;
                        // Add the "this" parameter to the call info
                        if (expr.kind === pxtc.SK.PropertyAccessExpression) {
                            // If the node is a property access, the right hand side is just
                            // the function name so grab the left instead
                            args.unshift(expr.expression);
                        }
                        else {
                            args.unshift(node.expression);
                        }
                    }
                }
                let callInfo = {
                    decl,
                    qName: decl ? pxtc.getNodeFullName(checker, decl) : "?",
                    args: args,
                    isExpression: hasRet
                };
                pxtc.pxtInfo(node).callInfo = callInfo;
            }
            function getDecl(node) {
                if (!node)
                    return null;
                let sym = checker.getSymbolAtLocation(node);
                let decl;
                if (sym) {
                    decl = sym.valueDeclaration;
                    if (!decl && sym.declarations) {
                        let decl0 = sym.declarations[0];
                        if (decl0 && decl0.kind == ts.SyntaxKind.ImportEqualsDeclaration) {
                            sym = checker.getSymbolAtLocation(decl0.moduleReference);
                            if (sym)
                                decl = sym.valueDeclaration;
                        }
                    }
                }
                if (!decl && node.kind == pxtc.SK.PropertyAccessExpression) {
                    const namedNode = node;
                    decl = {
                        kind: pxtc.SK.PropertySignature,
                        symbol: { isBogusSymbol: true, name: namedNode.name.getText() },
                        name: namedNode.name,
                    };
                    pxtc.pxtInfo(decl).flags |= 2 /* IsBogusFunction */;
                }
                return decl;
            }
            function typeOf(node) {
                let r;
                const info = pxtc.pxtInfo(node);
                if (info.typeCache)
                    return info.typeCache;
                if (ts.isExpression(node))
                    r = checker.getContextualType(node);
                if (!r) {
                    r = checker.getTypeAtLocation(node);
                }
                if (!r)
                    return r;
                if (ts.isStringLiteral(node))
                    return r; // skip checkType() - type is any for literal fragments
                return pxtc.checkType(r);
            }
        }
        pxtc.annotate = annotate;
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        function asmStringLiteral(s) {
            let r = "\"";
            for (let i = 0; i < s.length; ++i) {
                // TODO generate warning when seeing high character ?
                let c = s.charCodeAt(i) & 0xff;
                let cc = String.fromCharCode(c);
                if (cc == "\\" || cc == "\"")
                    r += "\\" + cc;
                else if (cc == "\n")
                    r += "\\n";
                else if (c <= 0xf)
                    r += "\\x0" + c.toString(16);
                else if (c < 32 || c > 127)
                    r += "\\x" + c.toString(16);
                else
                    r += cc;
            }
            return r + "\"";
        }
        pxtc.asmStringLiteral = asmStringLiteral;
        // this class defines the interface between the IR
        // and a particular assembler (Thumb, AVR). Thus,
        // the registers mentioned below are VIRTUAL registers
        // required by the IR-machine, rather than PHYSICAL registers
        // at the assembly level.
        // that said, the assumptions below about registers are based on
        // ARM, so a mapping will be needed for other processors
        // Assumptions:
        // - registers can hold a pointer (data or code)
        // - special registers include: sp
        // - fixed registers are r0, r1, r2, r3, r5, r6 
        //   - r0 is the current value (from expression evaluation)
        //   - registers for runtime calls (r0, r1,r2,r3)
        //   - r5 is for captured locals in lambda
        //   - r6 for global{}
        //   - r4 and r7 are used as temporary
        //   - C code assumes the following are calee saved: r4-r7, r8-r11
        //   - r12 is intra-procedure scratch and can be treated like r0-r3
        //   - r13 is sp, r14 is lr, r15 is pc
        // - for calls to user functions, all arguments passed on stack
        class AssemblerSnippets {
            nop() { return "TBD(nop)"; }
            reg_gets_imm(reg, imm) { return "TBD(reg_gets_imm)"; }
            // Registers are stored on the stack in numerical order 
            proc_setup(numlocals, main) { return "TBD(proc_setup)"; }
            push_fixed(reg) { return "TBD(push_fixed)"; }
            push_local(reg) { return "TBD(push_local)"; }
            push_locals(n) { return "TBD(push_locals)"; }
            pop_fixed(reg) { return "TBD(pop_fixed)"; }
            pop_locals(n) { return "TBD(pop_locals)"; }
            proc_return() { return "TBD(proc_return)"; }
            debugger_stmt(lbl) { return ""; }
            debugger_bkpt(lbl) { return ""; }
            debugger_proc(lbl) { return ""; }
            unconditional_branch(lbl) { return "TBD(unconditional_branch)"; }
            beq(lbl) { return "TBD(beq)"; }
            bne(lbl) { return "TBD(bne)"; }
            cmp(reg1, reg) { return "TBD(cmp)"; }
            cmp_zero(reg1) { return "TBD(cmp_zero)"; }
            arithmetic() { return ""; }
            // load_reg_src_off is load/store indirect
            // word? - does offset represent an index that must be multiplied by word size?
            // inf?  - control over size of referenced data
            // str?  - true=Store/false=Load
            // src - can range over
            load_reg_src_off(reg, src, off, word, store, inf) {
                return "TBD(load_reg_src_off)";
            }
            rt_call(name, r0, r1) { return "TBD(rt_call)"; }
            call_lbl(lbl, saveStack) { return "TBD(call_lbl)"; }
            call_reg(reg) { return "TBD(call_reg)"; }
            helper_prologue() { return "TBD(lambda_prologue)"; }
            helper_epilogue() { return "TBD(lambda_epilogue)"; }
            pop_clean(pops) { return "TBD"; }
            load_ptr_full(lbl, reg) { return "TBD(load_ptr_full)"; }
            emit_int(v, reg) { return "TBD(emit_int)"; }
            obj_header(vt) {
                return `.word ${vt}`;
            }
            string_literal(lbl, strLit) {
                const info = utf8AsmStringLiteral(strLit);
                return `
            .balign 4
            ${lbl}: ${this.obj_header(info.vt)}
            ${info.asm}
`;
            }
            hex_literal(lbl, data) {
                // if buffer looks as if it was prepared for in-app reprogramming (at least 8 bytes of 0xff)
                // align it to 8 bytes, to make sure it can be rewritten also on SAMD51
                const align = /f{16}/i.test(data) ? 8 : 4;
                return `
.balign ${align}
${lbl}: ${this.obj_header("pxt::buffer_vt")}
${hexLiteralAsm(data)}
`;
            }
        }
        pxtc.AssemblerSnippets = AssemblerSnippets;
        function utf8AsmStringLiteral(strLit) {
            const PXT_STRING_SKIP_INCR = 16;
            let vt = "pxt::string_inline_ascii_vt";
            let utfLit = pxtc.target.utf8 ? pxtc.U.toUTF8(strLit, true) : strLit;
            let asm = "";
            if (utfLit !== strLit) {
                if (strLit.length > PXT_STRING_SKIP_INCR) {
                    vt = "pxt::string_skiplist16_packed_vt";
                    let skipList = [];
                    let off = 0;
                    for (let i = 0; i + PXT_STRING_SKIP_INCR <= strLit.length; i += PXT_STRING_SKIP_INCR) {
                        off += pxtc.U.toUTF8(strLit.slice(i, i + PXT_STRING_SKIP_INCR), true).length;
                        skipList.push(off);
                    }
                    asm = `
    .short ${utfLit.length}, ${strLit.length}
    .short ${skipList.map(s => s.toString()).join(", ")}
    .string ${asmStringLiteral(utfLit)}
`;
                }
                else {
                    vt = "pxt::string_inline_utf8_vt";
                }
            }
            if (!asm)
                asm = `
    .short ${utfLit.length}
    .string ${asmStringLiteral(utfLit)}
`;
            return { vt, asm };
        }
        pxtc.utf8AsmStringLiteral = utf8AsmStringLiteral;
        function hexLiteralAsm(data, suff = "") {
            return `
                .word ${data.length >> 1}${suff}
                .hex ${data}${data.length % 4 == 0 ? "" : "00"}
        `;
        }
        pxtc.hexLiteralAsm = hexLiteralAsm;
        // helper for emit_int
        function numBytes(n) {
            let v = 0;
            for (let q = n; q > 0; q >>>= 8) {
                v++;
            }
            return v || 1;
        }
        pxtc.numBytes = numBytes;
        class ProctoAssembler {
            constructor(t, bin, proc) {
                this.resText = "";
                this.exprStack = [];
                this.calls = [];
                this.proc = null;
                this.baseStackSize = 0; // real stack size is this + exprStack.length
                this.labelledHelpers = {};
                this.write = (s) => { this.resText += pxtc.asmline(s); };
                this.t = t; // TODO in future, figure out if we follow the "Snippets" architecture
                this.bin = bin;
                this.proc = proc;
                if (this.proc)
                    this.work();
            }
            emitHelpers() {
                this.emitLambdaTrampoline();
                this.emitArrayMethods();
                this.emitFieldMethods();
                this.emitBindHelper();
            }
            redirectOutput(f) {
                let prevWrite = this.write;
                let res = "";
                this.write = s => res += pxtc.asmline(s);
                try {
                    f();
                }
                finally {
                    this.write = prevWrite;
                }
                return res;
            }
            stackSize() {
                return this.baseStackSize + this.exprStack.length;
            }
            stackAlignmentNeeded(offset = 0) {
                if (!pxtc.target.stackAlign)
                    return 0;
                let npush = pxtc.target.stackAlign - ((this.stackSize() + offset) & (pxtc.target.stackAlign - 1));
                if (npush == pxtc.target.stackAlign)
                    return 0;
                else
                    return npush;
            }
            getAssembly() {
                return this.resText;
            }
            work() {
                this.write(`
;
; Function ${this.proc.getFullName()}
;
`);
                let baseLabel = this.proc.label();
                let preLabel = baseLabel + "_pre";
                let bkptLabel = baseLabel + "_bkpt";
                let locLabel = baseLabel + "_locals";
                let endLabel = baseLabel + "_end";
                this.write(`${preLabel}:`);
                this.emitLambdaWrapper(this.proc.isRoot);
                this.write(`.section code`);
                this.write(`${baseLabel}:`);
                if (this.proc.classInfo && this.proc.info.thisParameter
                    && !pxtc.target.switches.skipClassCheck
                    && !pxtc.target.switches.noThisCheckOpt) {
                    this.write(`mov r7, lr`);
                    this.write(`ldr r0, [sp, #0]`);
                    this.emitInstanceOf(this.proc.classInfo, "validate");
                    this.write("mov lr, r7");
                }
                this.write(`
${baseLabel}_nochk:
    @stackmark func
    @stackmark args
`);
                // create a new function for later use by hex file generation
                this.proc.fillDebugInfo = th => {
                    let labels = th.getLabels();
                    this.proc.debugInfo = {
                        locals: (this.proc.seqNo == 1 ? this.bin.globals : this.proc.locals).map(l => l.getDebugInfo()),
                        args: this.proc.args.map(l => l.getDebugInfo()),
                        name: this.proc.getName(),
                        codeStartLoc: pxtc.U.lookup(labels, locLabel),
                        codeEndLoc: pxtc.U.lookup(labels, endLabel),
                        bkptLoc: pxtc.U.lookup(labels, bkptLabel),
                        localsMark: pxtc.U.lookup(th.stackAtLabel, locLabel),
                        idx: this.proc.seqNo,
                        calls: this.calls,
                        size: pxtc.U.lookup(labels, endLabel) + 2 - pxtc.U.lookup(labels, preLabel)
                    };
                    for (let ci of this.calls) {
                        ci.addr = pxtc.U.lookup(labels, ci.callLabel);
                        ci.stack = pxtc.U.lookup(th.stackAtLabel, ci.callLabel);
                        ci.callLabel = undefined; // don't waste space
                    }
                    for (let i = 0; i < this.proc.body.length; ++i) {
                        let bi = this.proc.body[i].breakpointInfo;
                        if (bi) {
                            let off = pxtc.U.lookup(th.stackAtLabel, `__brkp_${bi.id}`);
                            if (off !== this.proc.debugInfo.localsMark) {
                                console.log(bi);
                                console.log(th.stackAtLabel);
                                pxtc.U.oops(`offset doesn't match: ${off} != ${this.proc.debugInfo.localsMark}`);
                            }
                        }
                    }
                };
                if (this.bin.options.breakpoints) {
                    this.write(this.t.debugger_proc(bkptLabel));
                }
                this.baseStackSize = 1; // push {lr}
                let numlocals = this.proc.locals.length;
                this.write("push {lr}");
                this.write(".locals:\n");
                if (this.proc.perfCounterNo) {
                    this.write(this.t.emit_int(this.proc.perfCounterNo, "r0"));
                    this.write("bl pxt::startPerfCounter");
                }
                this.write(this.t.proc_setup(numlocals));
                this.baseStackSize += numlocals;
                this.write("@stackmark locals");
                this.write(`${locLabel}:`);
                for (let i = 0; i < this.proc.body.length; ++i) {
                    let s = this.proc.body[i];
                    // console.log("STMT", s.toString())
                    switch (s.stmtKind) {
                        case pxtc.ir.SK.Expr:
                            this.emitExpr(s.expr);
                            break;
                        case pxtc.ir.SK.StackEmpty:
                            if (this.exprStack.length > 0) {
                                for (let stmt of this.proc.body.slice(i - 4, i + 1))
                                    console.log(`PREVSTMT ${stmt.toString().trim()}`);
                                for (let e of this.exprStack)
                                    console.log(`EXPRSTACK ${e.currUses}/${e.totalUses} E: ${e.toString()}`);
                                pxtc.oops("stack should be empty");
                            }
                            this.write("@stackempty locals");
                            break;
                        case pxtc.ir.SK.Jmp:
                            this.emitJmp(s);
                            break;
                        case pxtc.ir.SK.Label:
                            this.write(s.lblName + ":");
                            this.validateJmpStack(s);
                            break;
                        case pxtc.ir.SK.Comment:
                            this.write(`; ${s.expr.data}`);
                            break;
                        case pxtc.ir.SK.Breakpoint:
                            if (this.bin.options.breakpoints) {
                                let lbl = `__brkp_${s.breakpointInfo.id}`;
                                if (s.breakpointInfo.isDebuggerStmt) {
                                    this.write(this.t.debugger_stmt(lbl));
                                }
                                else {
                                    this.write(this.t.debugger_bkpt(lbl));
                                }
                            }
                            break;
                        default: pxtc.oops();
                    }
                }
                pxtc.assert(0 <= numlocals && numlocals < 127);
                if (numlocals > 0)
                    this.write(this.t.pop_locals(numlocals));
                if (this.proc.perfCounterNo) {
                    this.write("mov r4, r0");
                    this.write(this.t.emit_int(this.proc.perfCounterNo, "r0"));
                    this.write("bl pxt::stopPerfCounter");
                    this.write("mov r0, r4");
                }
                this.write(`${endLabel}:`);
                this.write(this.t.proc_return());
                this.write("@stackempty func");
                this.write("@stackempty args");
                this.write("; endfun");
            }
            mkLbl(root) {
                let l = root + this.bin.lblNo++;
                if (l[0] != "_")
                    l = "." + l;
                return l;
            }
            dumpStack() {
                let r = "[";
                for (let s of this.exprStack) {
                    r += s.sharingInfo() + ": " + s.toString() + "; ";
                }
                r += "]";
                return r;
            }
            terminate(expr) {
                pxtc.assert(expr.exprKind == pxtc.ir.EK.SharedRef);
                let arg = expr.args[0];
                // console.log("TERM", arg.sharingInfo(), arg.toString(), this.dumpStack())
                pxtc.U.assert(arg.currUses != arg.totalUses);
                // we should have the terminated expression on top
                pxtc.U.assert(this.exprStack[0] === arg, "term at top");
                // we pretend it's popped and simulate what clearStack would do
                let numEntries = 1;
                while (numEntries < this.exprStack.length) {
                    let ee = this.exprStack[numEntries];
                    if (ee.currUses != ee.totalUses)
                        break;
                    numEntries++;
                }
                // in this branch we just remove all that stuff off the stack
                this.write(`@dummystack ${numEntries}`);
                this.write(this.t.pop_locals(numEntries));
                return numEntries;
            }
            validateJmpStack(lbl, off = 0) {
                // console.log("Validate:", off, lbl.lblName, this.dumpStack())
                let currSize = this.exprStack.length - off;
                if (lbl.lblStackSize == null) {
                    lbl.lblStackSize = currSize;
                }
                else {
                    if (lbl.lblStackSize != currSize) {
                        console.log(lbl.lblStackSize, currSize);
                        console.log(this.dumpStack());
                        pxtc.U.oops("stack misaligned at: " + lbl.lblName);
                    }
                }
            }
            emitJmp(jmp) {
                let termOff = 0;
                if (jmp.jmpMode == pxtc.ir.JmpMode.Always) {
                    if (jmp.expr)
                        this.emitExpr(jmp.expr);
                    if (jmp.terminateExpr)
                        termOff = this.terminate(jmp.terminateExpr);
                    this.write(this.t.unconditional_branch(jmp.lblName) + " ; with expression");
                }
                else {
                    let lbl = this.mkLbl("jmpz");
                    this.emitExpr(jmp.expr);
                    // TODO: remove ARM-specific code
                    if (jmp.expr.exprKind == pxtc.ir.EK.RuntimeCall &&
                        (jmp.expr.data === "thumb::subs" || pxtc.U.startsWith(jmp.expr.data, "_cmp_"))) {
                        // no cmp required
                    }
                    else {
                        this.write(this.t.cmp_zero("r0"));
                    }
                    if (jmp.jmpMode == pxtc.ir.JmpMode.IfNotZero) {
                        this.write(this.t.beq(lbl)); // this is to *skip* the following 'b' instruction; beq itself has a very short range
                    }
                    else {
                        // IfZero
                        this.write(this.t.bne(lbl));
                    }
                    if (jmp.terminateExpr)
                        termOff = this.terminate(jmp.terminateExpr);
                    this.write(this.t.unconditional_branch(jmp.lblName));
                    this.write(lbl + ":");
                }
                this.validateJmpStack(jmp.lbl, termOff);
            }
            clearStack(fast = false) {
                let numEntries = 0;
                while (this.exprStack.length > 0 && this.exprStack[0].currUses == this.exprStack[0].totalUses) {
                    numEntries++;
                    this.exprStack.shift();
                }
                if (numEntries)
                    this.write(this.t.pop_locals(numEntries));
                if (!fast) {
                    let toClear = this.exprStack.filter(e => e.currUses == e.totalUses && e.irCurrUses != -1);
                    if (toClear.length > 0) {
                        // use r7 as temp; r0-r3 might be used as arguments to functions
                        this.write(this.t.reg_gets_imm("r7", 0));
                        for (let a of toClear) {
                            a.irCurrUses = -1;
                            this.write(this.loadFromExprStack("r7", a, 0, true));
                        }
                    }
                }
            }
            emitExprInto(e, reg) {
                switch (e.exprKind) {
                    case pxtc.ir.EK.NumberLiteral:
                        if (typeof e.data == "number")
                            this.write(this.t.emit_int(e.data, reg));
                        else
                            pxtc.oops();
                        break;
                    case pxtc.ir.EK.PointerLiteral:
                        this.write(this.t.load_ptr_full(e.data, reg));
                        break;
                    case pxtc.ir.EK.SharedRef:
                        let arg = e.args[0];
                        pxtc.U.assert(!!arg.currUses); // not first use
                        pxtc.U.assert(arg.currUses < arg.totalUses);
                        arg.currUses++;
                        let idx = this.exprStack.indexOf(arg);
                        pxtc.U.assert(idx >= 0);
                        if (idx == 0 && arg.totalUses == arg.currUses) {
                            this.write(this.t.pop_fixed([reg]) + ` ; tmpref @${this.exprStack.length}`);
                            this.exprStack.shift();
                            this.clearStack();
                        }
                        else {
                            let idx0 = idx.toString() + ":" + this.exprStack.length;
                            this.write(this.t.load_reg_src_off(reg, "sp", idx0, true) + ` ; tmpref @${this.exprStack.length - idx}`);
                        }
                        break;
                    case pxtc.ir.EK.CellRef:
                        let cell = e.data;
                        if (cell.isGlobal()) {
                            let inf = this.bitSizeInfo(cell.bitSize);
                            let off = "#" + cell.index;
                            if (inf.needsSignExt || cell.index >= inf.immLimit) {
                                this.write(this.t.emit_int(cell.index, reg));
                                off = reg;
                            }
                            this.write(this.t.load_reg_src_off("r7", "r6", "#0"));
                            this.write(this.t.load_reg_src_off(reg, "r7", off, false, false, inf));
                        }
                        else {
                            let [src, imm, idx] = this.cellref(cell);
                            this.write(this.t.load_reg_src_off(reg, src, imm, idx));
                        }
                        break;
                    default: pxtc.oops();
                }
            }
            bitSizeInfo(b) {
                let inf = {
                    size: pxtc.sizeOfBitSize(b),
                    immLimit: 128
                };
                if (inf.size == 1) {
                    inf.immLimit = 32;
                }
                else if (inf.size == 2) {
                    inf.immLimit = 64;
                }
                if (b == 1 /* Int8 */ || b == 3 /* Int16 */) {
                    inf.needsSignExt = true;
                }
                return inf;
            }
            // result in R0
            emitExpr(e) {
                //console.log(`EMITEXPR ${e.sharingInfo()} E: ${e.toString()}`)
                switch (e.exprKind) {
                    case pxtc.ir.EK.JmpValue:
                        this.write("; jmp value (already in r0)");
                        break;
                    case pxtc.ir.EK.Nop:
                        // this is there because we need different addresses for breakpoints
                        this.write(this.t.nop());
                        break;
                    case pxtc.ir.EK.FieldAccess:
                        this.emitExpr(e.args[0]);
                        return this.emitFieldAccess(e);
                    case pxtc.ir.EK.Store:
                        return this.emitStore(e.args[0], e.args[1]);
                    case pxtc.ir.EK.RuntimeCall:
                        return this.emitRtCall(e);
                    case pxtc.ir.EK.ProcCall:
                        return this.emitProcCall(e);
                    case pxtc.ir.EK.SharedDef:
                        return this.emitSharedDef(e);
                    case pxtc.ir.EK.Sequence:
                        e.args.forEach(e => this.emitExpr(e));
                        return this.clearStack();
                    case pxtc.ir.EK.InstanceOf:
                        this.emitExpr(e.args[0]);
                        return this.emitInstanceOf(e.data, e.jsInfo);
                    default:
                        return this.emitExprInto(e, "r0");
                }
            }
            emitFieldAccess(e, store = false) {
                let info = e.data;
                let pref = store ? "st" : "ld";
                let lbl = pref + "fld_" + info.classInfo.id + "_" + info.name;
                if (info.needsCheck && !pxtc.target.switches.skipClassCheck) {
                    this.emitInstanceOf(info.classInfo, "validate");
                    lbl += "_chk";
                }
                let off = info.idx * 4 + 4;
                let xoff = "#" + off;
                if (off > 124) {
                    this.write(this.t.emit_int(off, "r3"));
                    xoff = "r3";
                }
                if (store)
                    this.write(`str r1, [r0, ${xoff}]`);
                else
                    this.write(`ldr r0, [r0, ${xoff}]`);
                return;
            }
            writeFailBranch() {
                this.write(`.fail:`);
                this.write(`mov r1, lr`);
                this.write(this.t.callCPP("pxt::failedCast"));
            }
            emitClassCall(procid) {
                let effIdx = procid.virtualIndex + pxtc.firstMethodOffset();
                this.write(this.t.emit_int(effIdx * 4, "r1"));
                let info = procid.classInfo;
                let suff = "";
                if (procid.isThis)
                    suff += "_this";
                this.emitLabelledHelper("classCall_" + info.id + suff, () => {
                    this.write(`ldr r0, [sp, #0] ; ld-this`);
                    this.loadVTable();
                    if (!pxtc.target.switches.skipClassCheck && !procid.isThis)
                        this.checkSubtype(info);
                    this.write(`ldr r1, [r3, r1] ; ld-method`);
                    this.write(`bx r1 ; keep lr from caller`);
                    this.writeFailBranch();
                });
            }
            emitBindHelper() {
                const maxArgs = 12;
                this.write(`
                .section code
                _pxt_bind_helper:
                    push {r0, r2}
                    movs r0, #2
                    ldlit r1, _pxt_bind_lit
                    ${this.t.callCPP("pxt::mkAction")}
                    pop {r1, r2}
                    str r1, [r0, #12]
                    str r2, [r0, #16]
                    bx r4 ; return

                _pxt_bind_lit:
                    ${this.t.obj_header("pxt::RefAction_vtable")}
                    .short 0, 0 ; no captured vars
                    .word .bindCode@fn
                .bindCode:
                    ; r0-bind object, r4-#args
                    cmp r4, #${maxArgs}
                    bge .fail
                    lsls r3, r4, #2
                    ldlit r2, _pxt_copy_list
                    ldr r1, [r2, r3]

                    ldr r3, [r0, #12]
                    ldr r2, [r0, #16]
                    adds r4, r4, #1
                    bx r1
            `);
                this.writeFailBranch();
                this.write(`_pxt_copy_list:`);
                this.write(pxtc.U.range(maxArgs).map(k => `.word _pxt_bind_${k}@fn`).join("\n"));
                for (let numargs = 0; numargs < maxArgs; numargs++) {
                    this.write(`
                _pxt_bind_${numargs}:
                    sub sp, #4
                `);
                    // inject recv argument
                    for (let i = 0; i < numargs; ++i) {
                        this.write(`ldr r1, [sp, #4*${i + 1}]`);
                        this.write(`str r1, [sp, #4*${i}]`);
                    }
                    this.write(`
                    push {r3} ; this-ptr
                    mov r1, lr
                    str r1, [sp, #4*${numargs + 1}] ; store LR
                    blx r2
                    ldr r1, [sp, #4*${numargs + 1}]
                    add sp, #8
                    bx r1
                `);
                }
            }
            ifaceCallCore(numargs, getset, noObjlit = false) {
                this.write(`
                ldr r2, [r3, #12] ; load mult
                movs r7, r2
                beq .objlit ; built-in types have mult=0
                muls r7, r1
                lsrs r7, r2
                lsls r7, r7, #1 ; r7 - hash offset
                ldr r3, [r3, #4] ; iface table
                adds r3, r3, r7
                ; r0-this, r1-method idx, r2-free, r3-hash entry, r4-num args, r7-free
                `);
                for (let i = 0; i < pxtc.vtLookups; ++i) {
                    if (i > 0)
                        this.write("    adds r3, #2");
                    this.write(`
                ldrh r2, [r3, #0] ; r2-offset of descriptor
                ldrh r7, [r2, r3] ; r7-method idx
                cmp r7, r1
                beq .hit
                `);
                }
                if (getset == "get") {
                    this.write("movs r0, #0 ; undefined");
                    this.write("bx lr");
                }
                else
                    this.write("b .fail2");
                this.write(`
            .hit:
                adds r3, r3, r2 ; r3-descriptor
                ldr r2, [r3, #4]
                lsls r7, r2, #31
                beq .field
            `);
                // here, it's a method entry in iface table
                const callIt = this.t.emit_int(numargs, "r4") + "\n     bx r2";
                if (getset == "set") {
                    this.write(`
                    ; check for next descriptor
                    ldrh r7, [r3, #8]
                    cmp r7, r1
                    bne .fail2 ; no setter!
                    ldr r2, [r3, #12]
                    ${callIt}
                `);
                }
                else {
                    this.write(`
                    ; check if it's getter
                    ldrh r7, [r3, #2]
                    cmp r7, #1
                `);
                    if (getset == "get") {
                        this.write(`
                        bne .bind
                        ${callIt}
                    .bind:
                        mov r4, lr
                        bl _pxt_bind_helper
                    `);
                    }
                    else {
                        this.write(`
                        beq .doublecall
                        ${callIt}
                    .doublecall:
                        ; call getter
                        movs r4, #1
                        push {r0, lr}
                        blx r2
                        pop {r1, r2}
                        mov lr, r2
                        b .moveArgs
                    `);
                    }
                }
                if (!noObjlit) {
                    this.write(`
                .objlit:
                    ldrh r2, [r3, #8]
                    cmp r2, #${pxt.BuiltInType.RefMap}
                    bne .fail
                    mov r4, lr
                `);
                    if (getset == "set") {
                        this.write("ldr r2, [sp, #4] ; ld-val");
                    }
                    this.write(this.t.callCPP(getset == "set" ? "pxtrt::mapSet" : "pxtrt::mapGet"));
                    if (getset) {
                        this.write("bx r4");
                    }
                    else {
                        this.write("mov lr, r4");
                        this.write("b .moveArgs");
                    }
                }
                this.write(".field:");
                if (getset == "set") {
                    this.write(`
                        ldr r3, [sp, #4] ; ld-val
                        str r3, [r0, r2] ; store field
                        bx lr
                    `);
                }
                else if (getset == "get") {
                    this.write(`
                        ldr r0, [r0, r2] ; load field
                        bx lr
                    `);
                }
                else {
                    this.write(`
                        ldr r0, [r0, r2] ; load field
                    `);
                }
                if (!getset) {
                    this.write(`.moveArgs:`);
                    for (let i = 0; i < numargs; ++i) {
                        if (i == numargs - 1)
                            // we keep the actual lambda value on the stack, so it won't be collected
                            this.write(`movs r1, r0`);
                        else
                            this.write(`ldr r1, [sp, #4*${i + 1}]`);
                        this.write(`str r1, [sp, #4*${i}]`);
                    }
                    // one argument consumed
                    this.lambdaCall(numargs - 1);
                }
                if (noObjlit)
                    this.write(".objlit:");
                this.writeFailBranch();
                this.write(`
            .fail2:
                ${this.t.callCPP("pxt::missingProperty")}
            `);
            }
            emitIfaceCall(procid, numargs, getset = "") {
                pxtc.U.assert(procid.ifaceIndex > 0);
                this.write(this.t.emit_int(procid.ifaceIndex, "r1"));
                this.emitLabelledHelper("ifacecall" + numargs + "_" + getset, () => {
                    this.write(`ldr r0, [sp, #0] ; ld-this`);
                    this.loadVTable();
                    this.ifaceCallCore(numargs, getset);
                });
            }
            // vtable in r3; clobber r2
            checkSubtype(info, failLbl = ".fail", r2 = "r2") {
                if (!info.classNo) {
                    this.write(`b ${failLbl} ; always fails; class never instantiated`);
                    return;
                }
                this.write(`ldrh ${r2}, [r3, #8]`);
                this.write(`cmp ${r2}, #${info.classNo}`);
                if (info.classNo == info.lastSubtypeNo) {
                    this.write(`bne ${failLbl}`); // different class
                }
                else {
                    this.write(`blt ${failLbl}`);
                    this.write(`cmp ${r2}, #${info.lastSubtypeNo}`);
                    this.write(`bgt ${failLbl}`);
                }
            }
            // keep r0, keep r1, clobber r2, vtable in r3
            loadVTable(r2 = "r2", taglbl = ".fail", nulllbl = ".fail") {
                this.write(`lsls ${r2}, r0, #30`);
                this.write(`bne ${taglbl}`); // tagged
                this.write(`cmp r0, #0`);
                this.write(`beq ${nulllbl}`); // null
                this.write(`ldr r3, [r0, #0]`);
                this.write("; vtable in R3");
            }
            emitInstanceOf(info, tp) {
                let lbl = "inst_" + info.id + "_" + tp;
                this.emitLabelledHelper(lbl, () => {
                    if (tp == "validateNullable")
                        this.loadVTable("r2", ".tagged", ".undefined");
                    else
                        this.loadVTable("r2", ".fail", ".fail");
                    this.checkSubtype(info);
                    if (tp == "bool") {
                        this.write(`movs r0, #${pxtc.taggedTrue}`);
                        this.write(`bx lr`);
                        this.write(`.fail:`);
                        this.write(`movs r0, #${pxtc.taggedFalse}`);
                        this.write(`bx lr`);
                    }
                    else if (tp == "validate") {
                        this.write(`bx lr`);
                        this.writeFailBranch();
                    }
                    else if (tp == "validateNullable") {
                        this.write(`.undefined:`);
                        this.write(`bx lr`);
                        this.write(`.tagged:`);
                        this.write(`cmp r0, #${pxtc.taggedNull} ; check for null`);
                        this.write(`bne .fail`);
                        this.write(`movs r0, #0`);
                        this.write(`bx lr`);
                        this.writeFailBranch();
                    }
                    else {
                        pxtc.U.oops();
                    }
                });
            }
            emitSharedDef(e) {
                let arg = e.args[0];
                pxtc.U.assert(arg.totalUses >= 1);
                pxtc.U.assert(arg.currUses === 0);
                arg.currUses = 1;
                if (arg.totalUses == 1)
                    return this.emitExpr(arg);
                else {
                    this.emitExpr(arg);
                    this.exprStack.unshift(arg);
                    this.write(this.t.push_local("r0") + "; tmpstore @" + this.exprStack.length);
                }
            }
            clearArgs(nonRefs, refs) {
                let numArgs = nonRefs.length + refs.length;
                let allArgs = nonRefs.concat(refs);
                for (let r of allArgs) {
                    if (r.currUses != 0 || r.totalUses != 1) {
                        console.log(r.toString());
                        console.log(allArgs.map(a => a.toString()));
                        pxtc.U.oops(`wrong uses: ${r.currUses} ${r.totalUses}`);
                    }
                    r.currUses = 1;
                }
                this.clearStack();
            }
            builtInClassNo(typeNo) {
                return { id: "builtin" + typeNo, classNo: typeNo, lastSubtypeNo: typeNo };
            }
            emitBeginTry(topExpr) {
                // this.write(`adr r0, ${topExpr.args[0].data}`)
                this.emitExprInto(topExpr.args[0], "r0");
                this.write(`bl _pxt_save_exception_state`);
            }
            emitRtCall(topExpr, genCall = null) {
                let name = topExpr.data;
                if (name == "pxt::beginTry") {
                    return this.emitBeginTry(topExpr);
                }
                let maskInfo = topExpr.mask || { refMask: 0 };
                let convs = maskInfo.conversions || [];
                let allArgs = topExpr.args.map((a, i) => ({
                    idx: i,
                    expr: a,
                    isSimple: a.isLiteral(),
                    isRef: (maskInfo.refMask & (1 << i)) != 0,
                    conv: convs.find(c => c.argIdx == i)
                }));
                pxtc.U.assert(allArgs.length <= 4);
                let seenUpdate = false;
                for (let a of pxtc.U.reversed(allArgs)) {
                    if (a.expr.isPure()) {
                        if (!a.isSimple && !a.isRef)
                            if (!seenUpdate || a.expr.isStateless())
                                a.isSimple = true;
                    }
                    else {
                        seenUpdate = true;
                    }
                }
                for (let a of allArgs) {
                    // we might want conversion from literal numbers to strings for example
                    if (a.conv)
                        a.isSimple = false;
                }
                let complexArgs = allArgs.filter(a => !a.isSimple);
                if (complexArgs.every(c => c.expr.isPure() && !c.isRef && !c.conv)) {
                    for (let c of complexArgs)
                        c.isSimple = true;
                    complexArgs = [];
                }
                let c0 = complexArgs[0];
                let clearStack = true;
                if (complexArgs.length == 1 && !c0.conv && !c0.isRef) {
                    this.emitExpr(c0.expr);
                    if (c0.idx != 0)
                        this.write(this.t.mov("r" + c0.idx, "r0"));
                    clearStack = false;
                }
                else {
                    for (let a of complexArgs)
                        this.pushArg(a.expr);
                    this.alignExprStack(0);
                    let convArgs = complexArgs.filter(a => !!a.conv);
                    if (convArgs.length) {
                        const conv = this.redirectOutput(() => {
                            let off = 0;
                            if (!pxtc.target.switches.inlineConversions) {
                                if (this.t.stackAligned())
                                    off += 2;
                                else
                                    off += 1;
                            }
                            for (let a of convArgs) {
                                if (pxtc.isThumb() && a.conv.method == "pxt::toInt") {
                                    // SPEED 2.5%
                                    this.write(this.loadFromExprStack("r0", a.expr, off));
                                    this.write("asrs r0, r0, #1");
                                    let idx = pxtc.target.switches.inlineConversions ? a.expr.getId() : off;
                                    this.write("bcs .isint" + idx);
                                    this.write("lsls r0, r0, #1");
                                    this.alignedCall(a.conv.method, "", off);
                                    this.write(".isint" + idx + ":");
                                    this.write(this.t.push_fixed(["r0"]));
                                }
                                else {
                                    this.write(this.loadFromExprStack("r0", a.expr, off));
                                    if (a.conv.refTag) {
                                        if (!pxtc.target.switches.skipClassCheck)
                                            this.emitInstanceOf(this.builtInClassNo(a.conv.refTag), a.conv.refTagNullable ? "validateNullable" : "validate");
                                    }
                                    else {
                                        this.alignedCall(a.conv.method, "", off);
                                        if (a.conv.returnsRef)
                                            // replace the entry on the stack with the return value,
                                            // as the original was already decr'ed, but the result
                                            // has yet to be
                                            this.write(this.loadFromExprStack("r0", a.expr, off, true));
                                    }
                                    this.write(this.t.push_fixed(["r0"]));
                                }
                                off++;
                            }
                            for (let a of pxtc.U.reversed(convArgs)) {
                                off--;
                                this.write(this.t.pop_fixed(["r" + a.idx]));
                            }
                            for (let a of complexArgs) {
                                if (!a.conv)
                                    this.write(this.loadFromExprStack("r" + a.idx, a.expr, off));
                            }
                        });
                        if (pxtc.target.switches.inlineConversions)
                            this.write(conv);
                        else
                            this.emitHelper(this.t.helper_prologue() + conv + this.t.helper_epilogue(), "conv");
                    }
                    else {
                        // not really worth a helper; some of this will be peep-holed away
                        for (let a of complexArgs)
                            this.write(this.loadFromExprStack("r" + a.idx, a.expr));
                    }
                }
                for (let a of allArgs)
                    if (a.isSimple)
                        this.emitExprInto(a.expr, "r" + a.idx);
                if (genCall) {
                    genCall();
                }
                else {
                    if (name != "langsupp::ignore")
                        this.alignedCall(name, "", 0, true);
                }
                if (clearStack) {
                    this.clearArgs(complexArgs.filter(a => !a.isRef).map(a => a.expr), complexArgs.filter(a => a.isRef).map(a => a.expr));
                }
            }
            alignedCall(name, cmt = "", off = 0, saveStack = false) {
                if (pxtc.U.startsWith(name, "_cmp_") || pxtc.U.startsWith(name, "_pxt_"))
                    saveStack = false;
                this.write(this.t.call_lbl(name, saveStack, this.stackAlignmentNeeded(off)) + cmt);
            }
            emitLabelledHelper(lbl, generate) {
                if (!this.labelledHelpers[lbl]) {
                    let outp = this.redirectOutput(generate);
                    this.emitHelper(outp, lbl);
                    this.labelledHelpers[lbl] = this.bin.codeHelpers[outp];
                }
                else {
                    this.write(this.t.call_lbl(this.labelledHelpers[lbl]));
                }
            }
            emitHelper(asm, baseName = "hlp") {
                if (!this.bin.codeHelpers[asm]) {
                    let len = Object.keys(this.bin.codeHelpers).length;
                    this.bin.codeHelpers[asm] = `_${baseName}_${len}`;
                }
                this.write(this.t.call_lbl(this.bin.codeHelpers[asm]));
            }
            pushToExprStack(a) {
                a.totalUses = 1;
                a.currUses = 0;
                this.exprStack.unshift(a);
            }
            pushArg(a) {
                this.clearStack(true);
                let bot = this.exprStack.length;
                this.emitExpr(a);
                this.clearStack(true);
                this.write(this.t.push_local("r0") + " ; proc-arg");
                this.pushToExprStack(a);
            }
            loadFromExprStack(r, a, off = 0, store = false) {
                let idx = this.exprStack.indexOf(a);
                pxtc.assert(idx >= 0);
                return this.t.load_reg_src_off(r, "sp", (idx + off).toString(), true, store) + ` ; estack\n`;
            }
            pushDummy() {
                let dummy = pxtc.ir.numlit(0);
                dummy.totalUses = 1;
                dummy.currUses = 1;
                this.exprStack.unshift(dummy);
            }
            alignExprStack(numargs) {
                let interAlign = this.stackAlignmentNeeded(numargs);
                if (interAlign) {
                    for (let i = 0; i < interAlign; ++i) {
                        // r5 should be safe to push on gc stack
                        this.write(`push {r5} ; align`);
                        this.pushDummy();
                    }
                }
            }
            emitFieldMethods() {
                for (let op of ["get", "set"]) {
                    this.write(`
                .section code
                _pxt_map_${op}:
                `);
                    this.loadVTable("r4");
                    this.checkSubtype(this.builtInClassNo(pxt.BuiltInType.RefMap), ".notmap", "r4");
                    this.write(this.t.callCPPPush(op == "set" ? "pxtrt::mapSetByString" : "pxtrt::mapGetByString"));
                    this.write(".notmap:");
                    let numargs = op == "set" ? 2 : 1;
                    let hasAlign = false;
                    this.write("mov r4, r3 ; save VT");
                    if (op == "set") {
                        if (pxtc.target.stackAlign) {
                            hasAlign = true;
                            this.write("push {lr} ; align");
                        }
                        this.write(`
                            push {r0, r2, lr}
                            mov r0, r1
                        `);
                    }
                    else {
                        this.write(`
                            push {r0, lr}
                            mov r0, r1
                        `);
                    }
                    this.write(`
                    bl pxtrt::lookupMapKey
                    mov r1, r0 ; put key index in r1
                    ldr r0, [sp, #0] ; restore obj pointer
                    mov r3, r4 ; restore vt
                    bl .dowork
                `);
                    this.write(this.t.pop_locals(numargs + (hasAlign ? 1 : 0)));
                    this.write("pop {pc}");
                    this.write(".dowork:");
                    this.ifaceCallCore(numargs, op, true);
                }
            }
            emitArrayMethod(op, isBuffer) {
                this.write(`
            .section code
            _pxt_${isBuffer ? "buffer" : "array"}_${op}:
            `);
                this.loadVTable("r4");
                let classNo = this.builtInClassNo(!isBuffer ?
                    pxt.BuiltInType.RefCollection : pxt.BuiltInType.BoxedBuffer);
                if (!pxtc.target.switches.skipClassCheck)
                    this.checkSubtype(classNo, ".fail", "r4");
                // on linux we use 32 bits for array size
                const ldrSize = pxtc.isStackMachine() || pxtc.target.runtimeIsARM || isBuffer ? "ldr" : "ldrh";
                this.write(`
                asrs r1, r1, #1
                bcc .notint
                ${ldrSize} r4, [r0, #${isBuffer ? 4 : 8}]
                cmp r1, r4
                bhs .oob
            `);
                let off = "r1";
                if (isBuffer) {
                    off = "#8";
                    this.write(`
                    adds r4, r0, r1
                `);
                }
                else {
                    this.write(`
                    lsls r1, r1, #2
                    ldr r4, [r0, #4]
                `);
                }
                let suff = isBuffer ? "b" : "";
                let conv = isBuffer && op == "get" ? "lsls r0, r0, #1\nadds r0, #1" : "";
                if (op == "set") {
                    this.write(`
                        str${suff} r2, [r4, ${off}]
                        bx lr
                    `);
                }
                else {
                    this.write(`
                        ldr${suff} r0, [r4, ${off}]
                        ${conv}
                        bx lr
                    `);
                }
                this.write(`
            .notint:
                lsls r1, r1, #1
                ${this.t.pushLR()}
                push {r0, r2}
                mov r0, r1
                ${this.t.callCPP("pxt::toInt")}
                mov r1, r0
                pop {r0, r2}
            .doop:
                ${this.t.callCPP(`Array_::${op}At`)}
                ${conv}
                ${this.t.popPC()}
            `);
                this.writeFailBranch();
                if (op == "get") {
                    this.write(`
                    .oob:
                        movs r0, #${isBuffer ? 1 : 0} ; 0 or undefined
                        bx lr
                `);
                }
                else {
                    this.write(`
                    .oob:
                        ${this.t.pushLR()}
                        b .doop
                `);
                }
            }
            emitArrayMethods() {
                for (let op of ["get", "set"]) {
                    this.emitArrayMethod(op, true);
                    this.emitArrayMethod(op, false);
                }
            }
            emitLambdaTrampoline() {
                let r3 = pxtc.target.stackAlign ? "r3," : "";
                this.write(`
            .section code
            _pxt_lambda_trampoline:
                push {${r3} r4, r5, r6, r7, lr}
                mov r4, r8
                mov r5, r9
                mov r6, r10
                mov r7, r11
                push {r4, r5, r6, r7} ; save high registers
                mov r4, r1
                mov r5, r2
                mov r6, r3
                mov r7, r0
                `);
                // TODO should inline this?
                this.emitInstanceOf(this.builtInClassNo(pxt.BuiltInType.RefAction), "validate");
                this.write(`
                mov r0, sp
                push {r4, r5, r6, r7} ; push args and the lambda
                mov r1, sp
                bl pxt::pushThreadContext
                mov r6, r0          ; save ctx or globals
                mov r5, r7          ; save lambda for closure
                mov r0, r5          ; also save lambda pointer in r0 - needed by pxt::bindMethod
                ldr r1, [r5, #8]    ; ld fnptr
                movs r4, #3         ; 3 args
                blx r1              ; execute the actual lambda
                mov r7, r0          ; save result
                @dummystack 4
                add sp, #4*4        ; remove arguments and lambda
                mov r0, r6   ; or pop the thread context
                bl pxt::popThreadContext
                mov r0, r7 ; restore result
                pop {r4, r5, r6, r7} ; restore high registers
                mov r8, r4
                mov r9, r5
                mov r10, r6
                mov r11, r7
                pop {${r3} r4, r5, r6, r7, pc}`);
                this.write(`
            .section code
            ; r0 - try frame
            ; r1 - handler PC
            _pxt_save_exception_state:
                push {r0, lr}
                ${this.t.callCPP("pxt::beginTry")}
                pop {r1, r4}
                str r1, [r0, #1*4] ; PC
                mov r1, sp
                str r1, [r0, #2*4] ; SP
                str r5, [r0, #3*4] ; lambda ptr
                bx r4
                `);
                this.write(`
            .section code
            ; r0 - try frame
            ; r1 - thread context
            _pxt_restore_exception_state:
                mov r6, r1
                ldr r1, [r0, #2*4] ; SP
                mov sp, r1
                ldr r5, [r0, #3*4] ; lambda ptr
                ldr r1, [r0, #1*4] ; PC
                movs r0, #1
                orrs r1, r0
                bx r1
                `);
                this.write(`
            .section code
            _pxt_stringConv:
            `);
                this.loadVTable();
                this.checkSubtype(this.builtInClassNo(pxt.BuiltInType.BoxedString), ".notstring");
                this.write(`
                bx lr

            .notstring: ; no string, but vtable in r3
                ldr r7, [r3, #4*${pxtc.firstMethodOffset() - 1}]
                cmp r7, #0
                beq .fail
                push {r0, lr}
                movs r4, #1
                blx r7
                str r0, [sp, #0]
                b .numops

            .fail: ; not an object or no toString
                push {r0, lr}
            .numops:
                ${this.t.callCPP("numops::toString")}
                pop {r1}
                pop {pc}
            `);
            }
            emitProcCall(topExpr) {
                let complexArgs = [];
                let theOne = null;
                let theOneReg = "";
                let procid = topExpr.data;
                if (procid.proc && procid.proc.inlineBody)
                    return this.emitExpr(procid.proc.inlineSelf(topExpr.args));
                let isLambda = procid.virtualIndex == -1;
                let seenUpdate = false;
                for (let c of pxtc.U.reversed(topExpr.args)) {
                    if (c.isPure()) {
                        if (!seenUpdate || c.isStateless())
                            continue;
                    }
                    else {
                        seenUpdate = true;
                    }
                    complexArgs.push(c);
                }
                complexArgs.reverse();
                if (complexArgs.length <= 1) {
                    // in case there is at most one complex argument, we don't need to re-push anything
                    let a0 = complexArgs[0];
                    if (a0) {
                        theOne = a0;
                        this.clearStack(true);
                        this.emitExpr(a0);
                        if (a0 == topExpr.args[topExpr.args.length - 1])
                            theOneReg = "r0";
                        else {
                            theOneReg = "r3";
                            this.write(this.t.mov("r3", "r0"));
                        }
                    }
                    complexArgs = [];
                }
                else {
                    for (let a of complexArgs)
                        this.pushArg(a);
                }
                this.alignExprStack(topExpr.args.length);
                // available registers; r7 can be used in loading globals, don't use it
                let regList = ["r1", "r2", "r3", "r4"];
                let regExprs = [];
                if (complexArgs.length) {
                    let maxDepth = -1;
                    for (let c of complexArgs) {
                        maxDepth = Math.max(this.exprStack.indexOf(c), maxDepth);
                    }
                    maxDepth++;
                    // we have 6 registers to play with
                    if (maxDepth <= regList.length) {
                        regList = regList.slice(0, maxDepth);
                        this.write(this.t.pop_fixed(regList));
                        regExprs = this.exprStack.splice(0, maxDepth);
                        // now push anything that isn't an argument
                        let pushList = [];
                        for (let i = maxDepth - 1; i >= 0; --i) {
                            if (complexArgs.indexOf(regExprs[i]) < 0) {
                                pushList.push(regList[i]);
                                this.exprStack.unshift(regExprs[i]);
                            }
                        }
                        if (pushList.length)
                            this.write(this.t.push_fixed(pushList));
                    }
                    else {
                        regList = null;
                        this.write(this.t.reg_gets_imm("r7", 0));
                    }
                }
                let argsToPush = pxtc.U.reversed(topExpr.args);
                // for lambda, move the first argument (lambda object) to the end
                if (isLambda)
                    argsToPush.unshift(argsToPush.pop());
                for (let a of argsToPush) {
                    if (complexArgs.indexOf(a) >= 0) {
                        if (regList) {
                            this.write(this.t.push_fixed([regList[regExprs.indexOf(a)]]));
                        }
                        else {
                            this.write(this.loadFromExprStack("r0", a));
                            this.write(this.t.push_local("r0") + " ; re-push");
                            this.write(this.loadFromExprStack("r7", a, 1, true));
                            let idx = this.exprStack.indexOf(a);
                            let theNull = pxtc.ir.numlit(0);
                            theNull.currUses = 1;
                            theNull.totalUses = 1;
                            this.exprStack[idx] = theNull;
                        }
                        this.exprStack.unshift(a);
                    }
                    else if (a === theOne) {
                        this.write(this.t.push_local(theOneReg) + " ; the one arg");
                        this.pushToExprStack(a);
                    }
                    else {
                        this.pushArg(a);
                    }
                }
                let lbl = this.mkLbl("_proccall");
                let procIdx = -1;
                if (isLambda) {
                    let numargs = topExpr.args.length - 1;
                    this.write(this.loadFromExprStack("r0", topExpr.args[0]));
                    this.emitLabelledHelper("lambda_call" + numargs, () => {
                        this.lambdaCall(numargs);
                        this.writeFailBranch();
                    });
                }
                else if (procid.virtualIndex != null || procid.ifaceIndex != null) {
                    if (procid.ifaceIndex != null) {
                        if (procid.isSet) {
                            pxtc.assert(topExpr.args.length == 2);
                            this.emitIfaceCall(procid, topExpr.args.length, "set");
                        }
                        else {
                            this.emitIfaceCall(procid, topExpr.args.length, procid.noArgs ? "get" : "");
                        }
                    }
                    else {
                        this.emitClassCall(procid);
                    }
                    this.write(lbl + ":");
                }
                else {
                    let proc = procid.proc;
                    procIdx = proc.seqNo;
                    this.write(this.t.call_lbl(proc.label() + (procid.isThis ? "_nochk" : "")));
                    this.write(lbl + ":");
                }
                this.calls.push({
                    procIndex: procIdx,
                    stack: 0,
                    addr: 0,
                    callLabel: lbl,
                });
                // note that we have to treat all arguments as refs,
                // because the procedure might have overriden them and we need to unref them
                // this doesn't apply to the lambda expression itself though
                if (isLambda && topExpr.args[0].isStateless()) {
                    this.clearArgs([topExpr.args[0]], topExpr.args.slice(1));
                }
                else {
                    this.clearArgs([], topExpr.args);
                }
            }
            lambdaCall(numargs) {
                this.write("; lambda call");
                this.loadVTable();
                if (!pxtc.target.switches.skipClassCheck)
                    this.checkSubtype(this.builtInClassNo(pxt.BuiltInType.RefAction));
                // the conditional branch below saves stack space for functions that do not require closure
                this.write(`
                movs r4, #${numargs}
                ldrh r1, [r0, #4]
                cmp r1, #0
                bne .pushR5
                ldr r1, [r0, #8]
                bx r1 ; keep lr from the caller
            .pushR5:
                sub sp, #8
            `);
                // move arguments two steps up
                for (let i = 0; i < numargs; ++i) {
                    this.write(`ldr r1, [sp, #4*${i + 2}]`);
                    this.write(`str r1, [sp, #4*${i}]`);
                }
                // save lr and r5 (outer lambda ctx) in the newly free spots
                this.write(`
                str r5, [sp, #4*${numargs}]
                mov r1, lr
                str r1, [sp, #4*${numargs + 1}]
                mov r5, r0
                ldr r7, [r5, #8]
                blx r7 ; exec actual lambda
                ldr r4, [sp, #4*${numargs + 1}] ; restore what was in LR
                ldr r5, [sp, #4*${numargs}] ; restore lambda ctx
            `);
                // move arguments back where they were
                for (let i = 0; i < numargs; ++i) {
                    this.write(`ldr r1, [sp, #4*${i}]`);
                    this.write(`str r1, [sp, #4*${i + 2}]`);
                }
                this.write(`
                add sp, #8
                bx r4
            `);
                this.write("; end lambda call");
            }
            emitStore(trg, src) {
                switch (trg.exprKind) {
                    case pxtc.ir.EK.CellRef:
                        let cell = trg.data;
                        this.emitExpr(src);
                        if (cell.isGlobal()) {
                            let inf = this.bitSizeInfo(cell.bitSize);
                            let off = "#" + cell.index;
                            if (cell.index >= inf.immLimit) {
                                this.write(this.t.emit_int(cell.index, "r1"));
                                off = "r1";
                            }
                            this.write(this.t.load_reg_src_off("r7", "r6", "#0"));
                            this.write(this.t.load_reg_src_off("r0", "r7", off, false, true, inf));
                        }
                        else {
                            let [reg, imm, off] = this.cellref(cell);
                            this.write(this.t.load_reg_src_off("r0", reg, imm, off, true));
                        }
                        break;
                    case pxtc.ir.EK.FieldAccess:
                        this.emitRtCall(pxtc.ir.rtcall("dummy", [trg.args[0], src]), () => this.emitFieldAccess(trg, true));
                        break;
                    default: pxtc.oops();
                }
            }
            cellref(cell) {
                if (cell.isGlobal()) {
                    throw pxtc.oops();
                }
                else if (cell.iscap) {
                    let idx = cell.index + 3;
                    pxtc.assert(0 <= idx && idx < 32);
                    return ["r5", idx.toString(), true];
                }
                else if (cell.isarg) {
                    let idx = cell.index;
                    return ["sp", "args@" + idx.toString() + ":" + this.baseStackSize, false];
                }
                else {
                    return ["sp", "locals@" + cell.index, false];
                }
            }
            emitLambdaWrapper(isMain) {
                this.write("");
                this.write(".section code");
                this.write(".balign 4");
                if (isMain)
                    this.proc.info.usedAsValue = true;
                if (!this.proc.info.usedAsValue && !this.proc.info.usedAsIface)
                    return;
                // TODO can use InlineRefAction_vtable or something to limit the size of the thing
                if (this.proc.info.usedAsValue) {
                    this.write(this.proc.label() + "_Lit:");
                    this.write(this.t.obj_header("pxt::RefAction_vtable"));
                    this.write(`.short 0, 0 ; no captured vars`);
                    this.write(`.word ${this.proc.label()}_args@fn`);
                }
                this.write(`${this.proc.label()}_args:`);
                let numargs = this.proc.args.length;
                if (numargs == 0)
                    return;
                this.write(`cmp r4, #${numargs}`);
                this.write(`bge ${this.proc.label()}_nochk`);
                let needsAlign = this.stackAlignmentNeeded(numargs + 1);
                let numpush = needsAlign ? numargs + 2 : numargs + 1;
                this.write(`push {lr}`);
                this.emitLabelledHelper(`expand_args_${numargs}`, () => {
                    this.write(`movs r0, #0`);
                    this.write(`movs r1, #0`);
                    if (needsAlign)
                        this.write(`push {r0}`);
                    for (let i = numargs; i > 0; i--) {
                        if (i != numargs) {
                            this.write(`cmp r4, #${i}`);
                            this.write(`blt .zero${i}`);
                            this.write(`ldr r0, [sp, #${numpush - 1}*4]`);
                            this.write(`str r1, [sp, #${numpush - 1}*4] ; clear existing`);
                            this.write(`.zero${i}:`);
                        }
                        this.write(`push {r0}`);
                    }
                    this.write(`bx lr`);
                });
                this.write(`bl ${this.proc.label()}_nochk`);
                let stackSize = numargs + (needsAlign ? 1 : 0);
                this.write(`@dummystack ${stackSize}`);
                this.write(`add sp, #4*${stackSize}`);
                this.write(`pop {pc}`);
            }
            emitCallRaw(name) {
                let inf = pxtc.hexfile.lookupFunc(name);
                pxtc.assert(!!inf, "unimplemented raw function: " + name);
                this.alignedCall(name);
            }
        }
        pxtc.ProctoAssembler = ProctoAssembler;
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        const jsOpMap = {
            "numops::adds": "+",
            "numops::subs": "-",
            "numops::div": "/",
            "numops::mod": "%",
            "numops::muls": "*",
            "numops::ands": "&",
            "numops::orrs": "|",
            "numops::eors": "^",
            "numops::bnot": "~",
            "numops::lsls": "<<",
            "numops::asrs": ">>",
            "numops::lsrs": ">>>",
            "numops::le": "<=",
            "numops::lt": "<",
            "numops::lt_bool": "<",
            "numops::ge": ">=",
            "numops::gt": ">",
            "numops::eq": "==",
            "pxt::eq_bool": "==",
            "pxt::eqq_bool": "===",
            "numops::eqq": "===",
            "numops::neqq": "!==",
            "numops::neq": "!=",
        };
        const shortNsCalls = {
            "pxsim.Boolean_": "",
            "pxsim.pxtcore": "",
            "pxsim.String_": "",
            "pxsim.ImageMethods": "",
            "pxsim.Array_": "",
            "pxsim.pxtrt": "",
            "pxsim.numops": "",
        };
        const shortCalls = {
            "pxsim.Array_.getAt": "",
            "pxsim.Array_.length": "",
            "pxsim.Array_.mk": "",
            "pxsim.Array_.push": "",
            "pxsim.Boolean_.bang": "",
            "pxsim.String_.concat": "",
            "pxsim.String_.stringConv": "",
            "pxsim.numops.toBool": "",
            "pxsim.numops.toBoolDecr": "",
            "pxsim.pxtcore.mkAction": "",
            "pxsim.pxtcore.mkClassInstance": "",
            "pxsim.pxtrt.ldlocRef": "",
            "pxsim.pxtrt.mapGetByString": "",
            "pxsim.pxtrt.stclo": "",
            "pxsim.pxtrt.stlocRef": "",
        };
        function shortCallsPrefix(m) {
            let r = "";
            for (let k of Object.keys(m)) {
                const kk = k.replace(/\./g, "_");
                m[k] = kk;
                r += `const ${kk} = ${k};\n`;
            }
            return r;
        }
        function isBuiltinSimOp(name) {
            return !!pxtc.U.lookup(jsOpMap, name.replace(/\./g, "::"));
        }
        pxtc.isBuiltinSimOp = isBuiltinSimOp;
        function shimToJs(shimName) {
            shimName = shimName.replace(/::/g, ".");
            if (shimName.slice(0, 4) == "pxt.")
                shimName = "pxtcore." + shimName.slice(4);
            const r = "pxsim." + shimName;
            if (shortCalls.hasOwnProperty(r))
                return shortCalls[r];
            const idx = r.lastIndexOf(".");
            if (idx > 0) {
                const pref = r.slice(0, idx);
                if (shortNsCalls.hasOwnProperty(pref))
                    return shortNsCalls[pref] + r.slice(idx);
            }
            return r;
        }
        pxtc.shimToJs = shimToJs;
        function vtableToJs(info) {
            pxtc.U.assert(info.classNo !== undefined);
            pxtc.U.assert(info.lastSubtypeNo !== undefined);
            let maxBg = parseInt(info.attrs.maxBgInstances);
            if (!maxBg)
                maxBg = null;
            let s = `const ${info.id}_VT = mkVTable({\n` +
                `  name: ${JSON.stringify(pxtc.getName(info.decl))},\n` +
                `  numFields: ${info.allfields.length},\n` +
                `  classNo: ${info.classNo},\n` +
                `  lastSubtypeNo: ${info.lastSubtypeNo},\n` +
                `  maxBgInstances: ${maxBg},\n` +
                `  methods: {\n`;
            for (let m of info.vtable) {
                s += `    "${m.getName()}": ${m.label()},\n`;
            }
            s += "  },\n";
            s += "  iface: {\n";
            for (let m of info.itable) {
                s += `    "${m.name}": ${m.proc ? m.proc.label() : "null"},\n`;
                if (m.setProc)
                    s += `    "set/${m.name}": ${m.setProc.label()},\n`;
                else if (!m.proc)
                    s += `    "set/${m.name}": null,\n`;
            }
            s += "  },\n";
            if (info.toStringMethod)
                s += "  toStringMethod: " + info.toStringMethod.label() + ",\n";
            s += "});\n";
            return s;
        }
        const evalIfaceFields = [
            "runtime",
            "oops",
            "doNothing",
            "pxsim",
            "globals",
            "maybeYield",
            "setupDebugger",
            "isBreakFrame",
            "breakpoint",
            "trace",
            "checkStack",
            "leave",
            "checkResumeConsumed",
            "setupResume",
            "setupLambda",
            "checkSubtype",
            "failedCast",
            "buildResume",
            "mkVTable",
            "bind",
            "leaveAccessor"
        ];
        function jsEmit(bin) {
            let jssource = "(function (ectx) {\n'use strict';\n";
            for (let n of evalIfaceFields) {
                jssource += `const ${n} = ectx.${n};\n`;
            }
            jssource += `const __this = runtime;\n`;
            jssource += `const pxtrt = pxsim.pxtrt;\n`;
            jssource += `let yieldSteps = 1;\n`;
            jssource += `ectx.setupYield(function() { yieldSteps = 100; })\n`;
            jssource += "pxsim.setTitle(" + JSON.stringify(bin.getTitle()) + ");\n";
            let cfg = {};
            let cfgKey = {};
            for (let ce of bin.res.configData || []) {
                cfg[ce.key + ""] = ce.value;
                cfgKey[ce.name] = ce.key;
            }
            jssource += "pxsim.setConfigData(" +
                JSON.stringify(cfg, null, 1) + ", " +
                JSON.stringify(cfgKey, null, 1) + ");\n";
            jssource += "pxtrt.mapKeyNames = " + JSON.stringify(bin.ifaceMembers, null, 1) + ";\n";
            const perfCounters = bin.setPerfCounters(["SysScreen"]);
            jssource += "__this.setupPerfCounters(" + JSON.stringify(perfCounters, null, 1) + ");\n";
            jssource += shortCallsPrefix(shortCalls);
            jssource += shortCallsPrefix(shortNsCalls);
            let cachedLen = 0;
            let newLen = 0;
            bin.procs.forEach(p => {
                let curr;
                if (p.cachedJS) {
                    curr = p.cachedJS;
                    cachedLen += curr.length;
                }
                else {
                    curr = irToJS(bin, p);
                    newLen += curr.length;
                }
                jssource += "\n" + curr + "\n";
            });
            jssource += pxtc.U.values(bin.codeHelpers).join("\n") + "\n";
            bin.usedClassInfos.forEach(info => {
                jssource += vtableToJs(info);
            });
            if (bin.res.breakpoints)
                jssource += `\nconst breakpoints = setupDebugger(${bin.res.breakpoints.length}, [${bin.globals.filter(c => c.isUserVariable).map(c => `"${c.uniqueName()}"`).join(",")}])\n`;
            jssource += `\nreturn ${bin.procs[0] ? bin.procs[0].label() : "null"}\n})\n`;
            const total = jssource.length;
            const perc = (n) => ((100 * n) / total).toFixed(2) + "%";
            const sizes = `// total=${jssource.length} new=${perc(newLen)} cached=${perc(cachedLen)} other=${perc(total - newLen - cachedLen)}\n`;
            bin.writeFile(pxtc.BINARY_JS, sizes + jssource);
        }
        pxtc.jsEmit = jsEmit;
        function irToJS(bin, proc) {
            if (proc.cachedJS)
                return proc.cachedJS;
            let resText = "";
            let writeRaw = (s) => { resText += s + "\n"; };
            let write = (s) => { resText += "    " + s + "\n"; };
            let EK = pxtc.ir.EK;
            let exprStack = [];
            let maxStack = 0;
            let localsCache = {};
            let hexlits = "";
            writeRaw(`
function ${proc.label()}(s) {
let r0 = s.r0, step = s.pc;
s.pc = -1;
`);
            if (proc.perfCounterNo) {
                writeRaw(`if (step == 0) __this.startPerfCounter(${proc.perfCounterNo});\n`);
            }
            writeRaw(`
while (true) {
if (yieldSteps-- < 0 && maybeYield(s, step, r0) || runtime !== pxsim.runtime) return null;
switch (step) {
  case 0:
`);
            proc.locals.forEach(l => {
                write(`${locref(l)} = undefined;`);
            });
            if (proc.args.length) {
                write(`if (s.lambdaArgs) {`);
                proc.args.forEach((l, i) => {
                    write(`  ${locref(l)} = (s.lambdaArgs[${i}]);`);
                });
                write(`  s.lambdaArgs = null;`);
                write(`}`);
            }
            if (proc.classInfo && proc.info.thisParameter) {
                write("r0 = s.arg0;");
                emitInstanceOf(proc.classInfo, "validate");
            }
            let lblIdx = 0;
            let asyncContinuations = [];
            for (let s of proc.body) {
                if (s.stmtKind == pxtc.ir.SK.Label && s.lblNumUses > 0)
                    s.lblId = ++lblIdx;
            }
            let idx = 0;
            for (let s of proc.body) {
                switch (s.stmtKind) {
                    case pxtc.ir.SK.Expr:
                        emitExpr(s.expr);
                        break;
                    case pxtc.ir.SK.StackEmpty:
                        stackEmpty();
                        break;
                    case pxtc.ir.SK.Jmp:
                        let isJmpNext = false;
                        for (let ii = idx + 1; ii < proc.body.length; ++ii) {
                            if (proc.body[ii].stmtKind != pxtc.ir.SK.Label)
                                break;
                            if (s.lbl == proc.body[ii]) {
                                isJmpNext = true;
                                break;
                            }
                        }
                        emitJmp(s, isJmpNext);
                        break;
                    case pxtc.ir.SK.Label:
                        if (s.lblNumUses > 0)
                            writeRaw(`  case ${s.lblId}:`);
                        break;
                    case pxtc.ir.SK.Comment:
                        writeRaw(`// ${s.expr.data}`);
                        break;
                    case pxtc.ir.SK.Breakpoint:
                        emitBreakpoint(s);
                        break;
                    default: pxtc.oops();
                }
                idx++;
            }
            stackEmpty();
            if (proc.perfCounterNo) {
                writeRaw(`__this.stopPerfCounter(${proc.perfCounterNo});\n`);
            }
            if (proc.isGetter())
                write(`return leaveAccessor(s, r0)`);
            else
                write(`return leave(s, r0)`);
            writeRaw(`  default: oops()`);
            writeRaw(`} } }`);
            let info = pxtc.nodeLocationInfo(proc.action);
            info.functionName = proc.getName();
            info.argumentNames = proc.args && proc.args.map(a => a.getName());
            writeRaw(`${proc.label()}.info = ${JSON.stringify(info)}`);
            if (proc.isGetter())
                writeRaw(`${proc.label()}.isGetter = true;`);
            if (proc.isRoot)
                writeRaw(`${proc.label()}.continuations = [ ${asyncContinuations.join(",")} ]`);
            writeRaw(fnctor(proc.label() + "_mk", proc.label(), maxStack, Object.keys(localsCache)));
            writeRaw(hexlits);
            proc.cachedJS = resText;
            return resText;
            // pre-create stack frame for this procedure with all the fields we need, so the
            // Hidden Class in the JIT is initalized optimally
            function fnctor(id, procname, numTmps, locals) {
                let r = "";
                r += `
function ${id}(s) {
    checkStack(s.depth);
    return {
        parent: s, fn: ${procname}, depth: s.depth + 1,
        pc: 0, retval: undefined, r0: undefined, overwrittenPC: false, lambdaArgs: null,
`;
                for (let i = 0; i < numTmps; ++i)
                    r += `  tmp_${i}: undefined,\n`;
                // this includes parameters
                for (let l of locals)
                    r += `  ${l}: undefined,\n`;
                r += `} }\n`;
                return r;
            }
            function emitBreakpoint(s) {
                let id = s.breakpointInfo.id;
                let lbl;
                write(`s.lastBrkId = ${id};`);
                if (bin.options.breakpoints) {
                    lbl = ++lblIdx;
                    let brkCall = `return breakpoint(s, ${lbl}, ${id}, r0);`;
                    if (s.breakpointInfo.isDebuggerStmt) {
                        write(brkCall);
                    }
                    else {
                        write(`if ((breakpoints[0] && isBreakFrame(s)) || breakpoints[${id}]) ${brkCall}`);
                        if (bin.options.trace) {
                            write(`else return trace(${id}, s, ${lbl}, ${proc.label()}.info);`);
                        }
                    }
                }
                else if (bin.options.trace) {
                    lbl = ++lblIdx;
                    write(`return trace(${id}, s, ${lbl}, ${proc.label()}.info);`);
                }
                else {
                    return;
                }
                writeRaw(`  case ${lbl}:`);
            }
            function locref(cell) {
                if (cell.isGlobal())
                    return "globals." + cell.uniqueName();
                else if (cell.iscap)
                    return `s.caps[${cell.index}]`;
                const un = cell.uniqueName();
                localsCache[un] = true;
                return "s." + un;
            }
            function emitJmp(jmp, isJmpNext) {
                if (jmp.lbl.lblNumUses == pxtc.ir.lblNumUsesJmpNext || isJmpNext) {
                    pxtc.assert(jmp.jmpMode == pxtc.ir.JmpMode.Always);
                    if (jmp.expr)
                        emitExpr(jmp.expr);
                    // no actual jump needed
                    return;
                }
                pxtc.assert(jmp.lbl.lblNumUses > 0);
                let trg = `{ step = ${jmp.lbl.lblId}; continue; }`;
                if (jmp.jmpMode == pxtc.ir.JmpMode.Always) {
                    if (jmp.expr)
                        emitExpr(jmp.expr);
                    write(trg);
                }
                else {
                    emitExpr(jmp.expr);
                    if (jmp.jmpMode == pxtc.ir.JmpMode.IfNotZero) {
                        write(`if (r0) ${trg}`);
                    }
                    else {
                        write(`if (!r0) ${trg}`);
                    }
                }
            }
            function canEmitInto(e) {
                switch (e.exprKind) {
                    case EK.NumberLiteral:
                    case EK.PointerLiteral:
                    case EK.SharedRef:
                    case EK.CellRef:
                        return true;
                    default:
                        return false;
                }
            }
            function emitExprPossiblyInto(e) {
                if (canEmitInto(e))
                    return emitExprInto(e);
                emitExpr(e);
                return "r0";
            }
            function emitExprInto(e) {
                switch (e.exprKind) {
                    case EK.NumberLiteral:
                        if (e.data === true)
                            return "true";
                        else if (e.data === false)
                            return "false";
                        else if (e.data === null)
                            return "null";
                        else if (e.data === undefined)
                            return "undefined";
                        else if (typeof e.data == "number")
                            return e.data + "";
                        else
                            throw pxtc.oops("invalid data: " + typeof e.data);
                    case EK.PointerLiteral:
                        if (e.ptrlabel()) {
                            return e.ptrlabel().lblId + "";
                        }
                        else if (e.hexlit() != null) {
                            hexlits += `const ${e.data} = pxsim.BufferMethods.createBufferFromHex("${e.hexlit()}")\n`;
                            return e.data;
                        }
                        else if (typeof e.jsInfo == "string") {
                            return e.jsInfo;
                        }
                        else {
                            pxtc.U.oops();
                        }
                    case EK.SharedRef:
                        let arg = e.args[0];
                        pxtc.U.assert(!!arg.currUses); // not first use
                        pxtc.U.assert(arg.currUses < arg.totalUses);
                        arg.currUses++;
                        let idx = exprStack.indexOf(arg);
                        pxtc.U.assert(idx >= 0);
                        return "s.tmp_" + idx;
                    case EK.CellRef:
                        let cell = e.data;
                        return locref(cell);
                    default: throw pxtc.oops();
                }
            }
            // result in R0
            function emitExpr(e) {
                //console.log(`EMITEXPR ${e.sharingInfo()} E: ${e.toString()}`)
                switch (e.exprKind) {
                    case EK.JmpValue:
                        write("// jmp value (already in r0)");
                        break;
                    case EK.Nop:
                        write("// nop");
                        break;
                    case EK.FieldAccess:
                        let info = e.data;
                        let shimName = info.shimName;
                        let obj = emitExprPossiblyInto(e.args[0]);
                        if (shimName) {
                            write(`r0 = ${obj}${shimName};`);
                            return;
                        }
                        write(`r0 = ${obj}.fields["${info.name}"];`);
                        return;
                    case EK.Store:
                        return emitStore(e.args[0], e.args[1]);
                    case EK.RuntimeCall:
                        return emitRtCall(e);
                    case EK.ProcCall:
                        return emitProcCall(e);
                    case EK.SharedDef:
                        return emitSharedDef(e);
                    case EK.Sequence:
                        return e.args.forEach(emitExpr);
                    case EK.InstanceOf:
                        emitExpr(e.args[0]);
                        emitInstanceOf(e.data, e.jsInfo);
                        return;
                    default:
                        write(`r0 = ${emitExprInto(e)};`);
                }
            }
            function checkSubtype(info, r0 = "r0") {
                const vt = `${info.id}_VT`;
                return `checkSubtype(${r0}, ${vt})`;
            }
            function emitInstanceOf(info, tp, r0 = "r0") {
                if (tp == "bool")
                    write(`r0 = ${checkSubtype(info)};`);
                else if (tp == "validate") {
                    write(`if (!${checkSubtype(info, r0)}) failedCast(${r0});`);
                }
                else {
                    pxtc.U.oops();
                }
            }
            function emitSharedDef(e) {
                let arg = e.args[0];
                pxtc.U.assert(arg.totalUses >= 1);
                pxtc.U.assert(arg.currUses === 0);
                arg.currUses = 1;
                if (arg.totalUses == 1)
                    return emitExpr(arg);
                else {
                    const idx = exprStack.length;
                    exprStack.push(arg);
                    let val = emitExprPossiblyInto(arg);
                    if (val != "r0")
                        val = "r0 = " + val;
                    write(`s.tmp_${idx} = ${val};`);
                }
            }
            function emitRtCall(topExpr) {
                let info = pxtc.ir.flattenArgs(topExpr.args);
                info.precomp.forEach(emitExpr);
                let name = topExpr.data;
                let args = info.flattened.map(emitExprInto);
                if (name == "langsupp::ignore")
                    return;
                let text = "";
                if (name[0] == ".")
                    text = `${args[0]}${name}(${args.slice(1).join(", ")})`;
                else if (name[0] == "=")
                    text = `(${args[0]})${name.slice(1)} = (${args[1]})`;
                else if (pxtc.U.startsWith(name, "new "))
                    text = `new ${shimToJs(name.slice(4))}(${args.join(", ")})`;
                else if (pxtc.U.lookup(jsOpMap, name))
                    text = args.length == 2 ? `(${args[0]} ${pxtc.U.lookup(jsOpMap, name)} ${args[1]})` : `(${pxtc.U.lookup(jsOpMap, name)} ${args[0]})`;
                else
                    text = `${shimToJs(name)}(${args.join(", ")})`;
                if (topExpr.callingConvention == 0 /* Plain */) {
                    write(`r0 = ${text};`);
                }
                else {
                    let loc = ++lblIdx;
                    asyncContinuations.push(loc);
                    if (name == "String_::stringConv") {
                        write(`if ((${args[0]}) && (${args[0]}).vtable) {`);
                    }
                    if (topExpr.callingConvention == 2 /* Promise */) {
                        write(`(function(cb) { ${text}.then(cb) })(buildResume(s, ${loc}));`);
                    }
                    else {
                        write(`setupResume(s, ${loc});`);
                        write(`${text};`);
                    }
                    write(`checkResumeConsumed();`);
                    write(`return;`);
                    if (name == "String_::stringConv")
                        write(`} else { s.retval = (${args[0]}) + ""; }`);
                    writeRaw(`  case ${loc}:`);
                    write(`r0 = s.retval;`);
                }
            }
            function emitProcCall(topExpr) {
                const procid = topExpr.data;
                const callproc = procid.proc;
                if (callproc && callproc.inlineBody)
                    return emitExpr(callproc.inlineSelf(topExpr.args));
                const frameExpr = pxtc.ir.rtcall("<frame>", []);
                frameExpr.totalUses = 1;
                frameExpr.currUses = 0;
                const frameIdx = exprStack.length;
                exprStack.push(frameExpr);
                const frameRef = `s.tmp_${frameIdx}`;
                const lblId = ++lblIdx;
                const isLambda = procid.virtualIndex == -1;
                if (callproc)
                    write(`${frameRef} = ${callproc.label()}_mk(s);`);
                else {
                    let id = "generic";
                    if (procid.ifaceIndex != null)
                        id = "if_" + bin.ifaceMembers[procid.ifaceIndex];
                    else if (isLambda)
                        id = "lambda";
                    else if (procid.virtualIndex != null)
                        id = procid.classInfo.id + "_v" + procid.virtualIndex;
                    else
                        pxtc.U.oops();
                    const argLen = topExpr.args.length;
                    id += "_" + argLen + "_mk";
                    bin.recordHelper(proc.usingCtx, id, () => {
                        const locals = pxtc.U.range(argLen).map(i => "arg" + i);
                        return fnctor(id, "null", 5, locals);
                    });
                    write(`${frameRef} = ${id}(s);`);
                }
                //console.log("PROCCALL", topExpr.toString())
                topExpr.args.forEach((a, i) => {
                    let arg = `arg${i}`;
                    if (isLambda) {
                        if (i == 0)
                            arg = `argL`;
                        else
                            arg = `arg${i - 1}`;
                    }
                    write(`${frameRef}.${arg} = ${emitExprPossiblyInto(a)};`);
                });
                let callIt = `s.pc = ${lblId}; return ${frameRef};`;
                if (procid.callLocationIndex != null) {
                    callIt = `s.callLocIdx = ${procid.callLocationIndex}; ${callIt}`;
                }
                if (procid.ifaceIndex != null) {
                    pxtc.U.assert(callproc == null);
                    const ifaceFieldName = bin.ifaceMembers[procid.ifaceIndex];
                    pxtc.U.assert(!!ifaceFieldName, `no name for ${procid.ifaceIndex}`);
                    write(`if (!${frameRef}.arg0.vtable.iface) {`);
                    let args = topExpr.args.map((a, i) => `${frameRef}.arg${i}`);
                    args.splice(1, 0, JSON.stringify(ifaceFieldName));
                    const accessor = `pxsim_pxtrt.map${procid.isSet ? "Set" : "Get"}ByString`;
                    if (procid.noArgs)
                        write(`  s.retval = ${accessor}(${args.join(", ")});`);
                    else {
                        pxtc.U.assert(!procid.isSet);
                        write(`  setupLambda(${frameRef}, ${accessor}(${args.slice(0, 2).join(", ")}), ${topExpr.args.length});`);
                        write(`  ${callIt}`);
                    }
                    write(`} else {`);
                    write(`  ${frameRef}.fn = ${frameRef}.arg0.vtable.iface["${procid.isSet ? "set/" : ""}${ifaceFieldName}"];`);
                    let fld = `${frameRef}.arg0.fields["${ifaceFieldName}"]`;
                    if (procid.isSet) {
                        write(`  if (${frameRef}.fn === null) { ${fld} = ${frameRef}.arg1; }`);
                        write(`  else if (${frameRef}.fn === undefined) { failedCast(${frameRef}.arg0) } `);
                    }
                    else if (procid.noArgs) {
                        write(`  if (${frameRef}.fn == null) { s.retval = ${fld}; }`);
                        write(`  else if (!${frameRef}.fn.isGetter) { s.retval = bind(${frameRef}); }`);
                    }
                    else {
                        write(`  if (${frameRef}.fn == null) { setupLambda(${frameRef}, ${fld}, ${topExpr.args.length}); ${callIt} }`);
                        // this is tricky - we need to do two calls, first to the accessor
                        // and then on the returned lambda - this is handled by leaveAccessor() runtime
                        // function
                        write(`  else if (${frameRef}.fn.isGetter) { ${frameRef}.stage2Call = true; ${callIt}; }`);
                    }
                    write(` else { ${callIt} }`);
                    write(`}`);
                    callIt = "";
                }
                else if (procid.virtualIndex == -1) {
                    // lambda call
                    pxtc.U.assert(callproc == null);
                    write(`setupLambda(${frameRef}, ${frameRef}.argL);`);
                }
                else if (procid.virtualIndex != null) {
                    pxtc.U.assert(callproc == null);
                    pxtc.assert(procid.virtualIndex >= 0);
                    emitInstanceOf(procid.classInfo, "validate", frameRef + ".arg0");
                    const meth = procid.classInfo.vtable[procid.virtualIndex];
                    write(`${frameRef}.fn = ${frameRef}.arg0.vtable.methods.${meth.getName()};`);
                }
                else {
                    pxtc.U.assert(callproc != null);
                }
                if (callIt)
                    write(callIt);
                writeRaw(`  case ${lblId}:`);
                write(`r0 = s.retval;`);
                frameExpr.currUses = 1;
            }
            function bitSizeConverter(b) {
                switch (b) {
                    case 0 /* None */: return "";
                    case 1 /* Int8 */: return "pxtrt.toInt8";
                    case 3 /* Int16 */: return "pxtrt.toInt16";
                    case 5 /* Int32 */: return "pxtrt.toInt32";
                    case 2 /* UInt8 */: return "pxtrt.toUInt8";
                    case 4 /* UInt16 */: return "pxtrt.toUInt16";
                    case 6 /* UInt32 */: return "pxtrt.toUInt32";
                    default: throw pxtc.oops();
                }
            }
            function emitStore(trg, src) {
                switch (trg.exprKind) {
                    case EK.CellRef:
                        let cell = trg.data;
                        let src2 = emitExprPossiblyInto(src);
                        write(`${locref(cell)} = ${bitSizeConverter(cell.bitSize)}(${src2});`);
                        break;
                    case EK.FieldAccess:
                        let info = trg.data;
                        let shimName = info.shimName;
                        if (!shimName)
                            shimName = `.fields["${info.name}"]`;
                        emitExpr(pxtc.ir.rtcall("=" + shimName, [trg.args[0], src]));
                        break;
                    default: pxtc.oops();
                }
            }
            function stackEmpty() {
                for (let e of exprStack) {
                    if (e.totalUses !== e.currUses)
                        pxtc.oops();
                }
                maxStack = Math.max(exprStack.length, maxStack);
                exprStack = [];
            }
        }
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
// Make sure backbase.ts is loaded before us, otherwise 'extends AssemblerSnippets' fails at runtime
/// <reference path="backbase.ts"/>
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        pxtc.thumbCmpMap = {
            "numops::lt": "_cmp_lt",
            "numops::gt": "_cmp_gt",
            "numops::le": "_cmp_le",
            "numops::ge": "_cmp_ge",
            "numops::eq": "_cmp_eq",
            "numops::eqq": "_cmp_eqq",
            "numops::neq": "_cmp_neq",
            "numops::neqq": "_cmp_neqq",
        };
        const inlineArithmetic = {
            "numops::adds": "_numops_adds",
            "numops::subs": "_numops_subs",
            "numops::orrs": "_numops_orrs",
            "numops::eors": "_numops_eors",
            "numops::ands": "_numops_ands",
            "numops::lsls": "_numops_lsls",
            "numops::asrs": "_numops_asrs",
            "numops::lsrs": "_numops_lsrs",
            "pxt::toInt": "_numops_toInt",
            "pxt::fromInt": "_numops_fromInt",
        };
        // snippets for ARM Thumb assembly
        class ThumbSnippets extends pxtc.AssemblerSnippets {
            stackAligned() {
                return pxtc.target.stackAlign && pxtc.target.stackAlign > 1;
            }
            pushLR() {
                // r5 should contain GC-able value
                if (this.stackAligned())
                    return "push {lr, r5}  ; r5 for align";
                else
                    return "push {lr}";
            }
            popPC() {
                if (this.stackAligned())
                    return "pop {pc, r5}  ; r5 for align";
                else
                    return "pop {pc}";
            }
            nop() { return "nop"; }
            mov(trg, dst) {
                return `mov ${trg}, ${dst}`;
            }
            helper_ret() {
                return `bx r4`;
            }
            reg_gets_imm(reg, imm) {
                return `movs ${reg}, #${imm}`;
            }
            push_fixed(regs) { return "push {" + regs.join(", ") + "}"; }
            pop_fixed(regs) { return "pop {" + regs.join(", ") + "}"; }
            proc_setup(numlocals, main) {
                let r = "";
                if (numlocals > 0) {
                    r += "    movs r0, #0\n";
                    for (let i = 0; i < numlocals; ++i)
                        r += "    push {r0} ;loc\n";
                }
                return r;
            }
            proc_return() { return "pop {pc}"; }
            debugger_stmt(lbl) {
                pxtc.oops();
                return `
    @stackempty locals
    ldr r0, [r6, #0] ; debugger
    subs r0, r0, #4  ; debugger
${lbl}:
    ldr r0, [r0, #0] ; debugger
`;
            }
            debugger_bkpt(lbl) {
                pxtc.oops();
                return `
    @stackempty locals
    ldr r0, [r6, #0] ; brk
${lbl}:
    ldr r0, [r0, #0] ; brk
`;
            }
            debugger_proc(lbl) {
                pxtc.oops();
                return `
    ldr r0, [r6, #0]  ; brk-entry
    ldr r0, [r0, #4]  ; brk-entry
${lbl}:`;
            }
            push_local(reg) { return `push {${reg}}`; }
            push_locals(n) { return `sub sp, #4*${n} ; push locals ${n} (align)`; }
            pop_locals(n) { return `add sp, #4*${n} ; pop locals ${n}`; }
            unconditional_branch(lbl) { return "bb " + lbl; }
            beq(lbl) { return "beq " + lbl; }
            bne(lbl) { return "bne " + lbl; }
            cmp(reg1, reg2) { return "cmp " + reg1 + ", " + reg2; }
            cmp_zero(reg1) { return "cmp " + reg1 + ", #0"; }
            load_reg_src_off(reg, src, off, word, store, inf) {
                off = off.replace(/:\d+$/, "");
                if (word) {
                    off = `#4*${off}`;
                }
                let str = "str";
                let ldr = "ldr";
                if (inf) {
                    if (inf.immLimit == 32)
                        str = "strb";
                    else if (inf.immLimit == 64)
                        str = "strh";
                    if (inf.needsSignExt)
                        ldr = str.replace("str", "ldrs");
                    else
                        ldr = str.replace("str", "ldr");
                }
                if (store)
                    return `${str} ${reg}, [${src}, ${off}]`;
                else
                    return `${ldr} ${reg}, [${src}, ${off}]`;
            }
            rt_call(name, r0, r1) {
                return name + " " + r0 + ", " + r1;
            }
            alignedCall(lbl, stackAlign) {
                if (stackAlign)
                    return `${this.push_locals(stackAlign)}\nbl ${lbl}\n${this.pop_locals(stackAlign)}`;
                else
                    return "bl " + lbl;
            }
            call_lbl(lbl, saveStack, stackAlign) {
                let o = pxtc.U.lookup(inlineArithmetic, lbl);
                if (o) {
                    lbl = o;
                    saveStack = false;
                }
                if (!saveStack && lbl.indexOf("::") > 0)
                    saveStack = true;
                if (saveStack)
                    return this.callCPP(lbl, stackAlign);
                else
                    return this.alignedCall(lbl, stackAlign);
            }
            call_reg(reg) {
                return "blx " + reg;
            }
            helper_prologue() {
                return `
    @stackmark args
    ${this.pushLR()}
`;
            }
            helper_epilogue() {
                return `
    ${this.popPC()}
    @stackempty args
`;
            }
            load_ptr_full(lbl, reg) {
                pxtc.assert(!!lbl);
                return `
    ldlit ${reg}, ${lbl}
`;
            }
            load_vtable(trg, src) {
                return `ldr ${trg}, [${src}, #0]`;
            }
            lambda_init() {
                return `
    mov r5, r0
    mov r4, lr
    bl pxtrt::getGlobalsPtr
    mov r6, r0
    bx r4
`;
            }
            saveThreadStack() {
                return "mov r7, sp\n    str r7, [r6, #4]\n";
            }
            restoreThreadStack() {
                if (pxtc.target.switches.gcDebug)
                    return "movs r7, #0\n    str r7, [r6, #4]\n";
                else
                    return "";
            }
            callCPPPush(lbl) {
                return this.pushLR() + "\n" + this.callCPP(lbl) + "\n" + this.popPC() + "\n";
            }
            callCPP(lbl, stackAlign) {
                return this.saveThreadStack() + this.alignedCall(lbl, stackAlign) + "\n" + this.restoreThreadStack();
            }
            inline_decr(idx) {
                // TODO optimize sequences of pops without decr into sub on sp
                return `
    lsls r1, r0, #30
    bne .tag${idx}
    bl _pxt_decr
.tag${idx}:
`;
            }
            arithmetic() {
                let r = "";
                const boxedOp = (op) => {
                    let r = ".boxed:\n";
                    r += `
                    ${this.pushLR()}
                    push {r0, r1}
                    ${this.saveThreadStack()}
                    ${op}
                    ${this.restoreThreadStack()}
                    add sp, #8
                    ${this.popPC()}
                `;
                    return r;
                };
                const checkInts = (op) => {
                    r += `
_numops_${op}:
    @scope _numops_${op}
    lsls r2, r0, #31
    beq .boxed
    lsls r2, r1, #31
    beq .boxed
`;
                };
                const finishOp = (op) => {
                    r += `    blx lr\n`;
                    r += boxedOp(`bl numops::${op}`);
                };
                for (let op of ["adds", "subs"]) {
                    checkInts(op);
                    r += `
    subs r2, r1, #1
    ${op} r2, r0, r2
    bvs .boxed
    movs r0, r2
`;
                    finishOp(op);
                }
                for (let op of ["ands", "orrs", "eors"]) {
                    checkInts(op);
                    r += `    ${op} r0, r1\n`;
                    if (op == "eors")
                        r += `    adds r0, r0, #1\n`;
                    finishOp(op);
                }
                for (let op of ["lsls", "lsrs", "asrs"]) {
                    checkInts(op);
                    r += `
    ; r3 := (r1 >> 1) & 0x1f
    lsls r3, r1, #26
    lsrs r3, r3, #27
`;
                    if (op == "asrs")
                        r += `
    asrs r0, r3
    movs r2, #1
    orrs r0, r2
`;
                    else {
                        if (op == "lsrs")
                            r += `
    asrs r2, r0, #1
    lsrs r2, r3
    lsrs r3, r2, #30
    bne .boxed
`;
                        else
                            r += `
    asrs r2, r0, #1
    lsls r2, r3
    lsrs r3, r2, #30
    beq .ok
    cmp r3, #3
    bne .boxed
.ok:
`;
                        r += `
    lsls r0, r2, #1
    adds r0, r0, #1
`;
                    }
                    finishOp(op);
                }
                r += `
@scope _numops_toInt
_numops_toInt:
    asrs r0, r0, #1
    bcc .over
    blx lr
.over:
    lsls r0, r0, #1
    ${this.callCPPPush("pxt::toInt")}

_numops_fromInt:
    lsls r2, r0, #1
    asrs r1, r2, #1
    cmp r0, r1
    bne .over2
    adds r0, r2, #1
    blx lr
.over2:
    ${this.callCPPPush("pxt::fromInt")}
`;
                for (let op of Object.keys(pxtc.thumbCmpMap)) {
                    op = op.replace(/.*::/, "");
                    // this make sure to set the Z flag correctly
                    r += `
.section code
_cmp_${op}:
    lsls r2, r0, #31
    beq .boxed
    lsls r2, r1, #31
    beq .boxed
    subs r0, r1
    b${op.replace("qq", "q").replace("neq", "ne")} .true
.false:
    movs r0, #0
    bx lr
.true:
    movs r0, #1
    bx lr
`;
                    // the cmp isn't really needed, given how toBoolDecr() is compiled,
                    // but better not rely on it
                    // Also, cmp isn't needed when ref-counting (it ends with movs r0, r4)
                    r += boxedOp(`
                        bl numops::${op}
                        bl numops::toBoolDecr
                        cmp r0, #0`);
                }
                return r;
            }
            emit_int(v, reg) {
                let movWritten = false;
                function writeMov(v) {
                    pxtc.assert(0 <= v && v <= 255);
                    let result = "";
                    if (movWritten) {
                        if (v)
                            result = `adds ${reg}, #${v}\n`;
                    }
                    else
                        result = `movs ${reg}, #${v}\n`;
                    movWritten = true;
                    return result;
                }
                function shift(v = 8) {
                    return `lsls ${reg}, ${reg}, #${v}\n`;
                }
                pxtc.assert(v != null);
                let n = Math.floor(v);
                let isNeg = false;
                if (n < 0) {
                    isNeg = true;
                    n = -n;
                }
                // compute number of lower-order 0s and shift that amount
                let numShift = 0;
                if (n > 0xff) {
                    let shifted = n;
                    while ((shifted & 1) == 0) {
                        shifted >>>= 1;
                        numShift++;
                    }
                    if (pxtc.numBytes(shifted) < pxtc.numBytes(n)) {
                        n = shifted;
                    }
                    else {
                        numShift = 0;
                    }
                }
                let result = "";
                switch (pxtc.numBytes(n)) {
                    case 4:
                        result += writeMov((n >>> 24) & 0xff);
                        result += shift();
                    case 3:
                        result += writeMov((n >>> 16) & 0xff);
                        result += shift();
                    case 2:
                        result += writeMov((n >>> 8) & 0xff);
                        result += shift();
                    case 1:
                        result += writeMov(n & 0xff);
                        break;
                    default:
                        pxtc.oops();
                }
                if (numShift)
                    result += shift(numShift);
                if (isNeg) {
                    result += `negs ${reg}, ${reg}\n`;
                }
                if (result.split("\n").length > 3 + 1) {
                    // more than 3 instructions? replace with LDR at PC-relative address
                    return `ldlit ${reg}, ${Math.floor(v)}\n`;
                }
                return result;
            }
        }
        pxtc.ThumbSnippets = ThumbSnippets;
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        const vmSpecOpcodes = {
            "pxtrt::mapSetGeneric": "mapset",
            "pxtrt::mapGetGeneric": "mapget",
        };
        const vmCallMap = {};
        function shimToVM(shimName) {
            return shimName;
        }
        function qs(s) {
            return JSON.stringify(s);
        }
        function vtableToVM(info, opts, bin) {
            /*
            uint16_t numbytes;
            ValType objectType;
            uint8_t magic;
            uint32_t padding;
            PVoid *ifaceTable;
            BuiltInType classNo;
            uint16_t reserved;
            uint32_t ifaceHashMult;
            uint32_t padding;
            PVoid methods[2 or 4];
            */
            const ifaceInfo = pxtc.computeHashMultiplier(info.itable.map(e => e.idx));
            //if (info.itable.length == 0)
            //    ifaceInfo.mult = 0
            const mapping = pxtc.U.toArray(ifaceInfo.mapping);
            while (mapping.length & 3)
                mapping.push(0);
            let s = `
${vtName(info)}_start:
        .short ${info.allfields.length * 8 + 8}  ; size in bytes
        .byte ${pxt.ValTypeObject}, ${pxt.VTABLE_MAGIC} ; magic
        .short ${mapping.length} ; entries in iface hashmap
        .short ${info.lastSubtypeNo || info.classNo} ; last sub class-id
        .short ${info.classNo} ; class-id
        .short 0 ; reserved
        .word ${ifaceInfo.mult} ; hash-mult
`;
            if (embedVTs()) {
                s += `
            .word pxt::RefRecord_destroy
            .word pxt::RefRecord_print
            .word pxt::RefRecord_scan
            .word pxt::RefRecord_gcsize
            .word 0,0,0,0 ; keep in sync with VM_NUM_CPP_METHODS
`;
            }
            else {
                s += `
            .word 0,0, 0,0, 0,0, 0,0 ; space for 4 (VM_NUM_CPP_METHODS) native methods
`;
            }
            s += `
        .balign 4
${info.id}_IfaceVT:
`;
            const descSize = 1;
            const zeroOffset = mapping.length >> 2;
            let descs = "";
            let offset = zeroOffset;
            let offsets = {};
            for (let e of info.itable) {
                offsets[e.idx + ""] = offset;
                const desc = !e.proc ? 0 : e.proc.isGetter() ? 1 : 2;
                descs += `  .short ${e.idx}, ${desc} ; ${e.name}\n`;
                descs += `  .word ${e.proc ? e.proc.vtLabel() + "@fn" : e.info}\n`;
                offset += descSize;
                if (e.setProc) {
                    descs += `  .short ${e.idx}, 2 ; set ${e.name}\n`;
                    descs += `  .word ${e.setProc.vtLabel()}@fn\n`;
                    offset += descSize;
                }
            }
            descs += "  .word 0, 0, 0, 0 ; the end\n";
            offset += descSize;
            for (let i = 0; i < mapping.length; ++i) {
                bin.itEntries++;
                if (mapping[i])
                    bin.itFullEntries++;
            }
            s += "  .short " + pxtc.U.toArray(mapping).map((e, i) => offsets[e + ""] || zeroOffset).join(", ") + "\n";
            s += descs;
            s += "\n";
            return s;
        }
        // keep in sync with vm.h
        let SectionType;
        (function (SectionType) {
            SectionType[SectionType["Invalid"] = 0] = "Invalid";
            // singular sections
            SectionType[SectionType["InfoHeader"] = 1] = "InfoHeader";
            SectionType[SectionType["OpCodeMap"] = 2] = "OpCodeMap";
            SectionType[SectionType["NumberLiterals"] = 3] = "NumberLiterals";
            SectionType[SectionType["ConfigData"] = 4] = "ConfigData";
            SectionType[SectionType["IfaceMemberNames"] = 5] = "IfaceMemberNames";
            SectionType[SectionType["NumberBoxes"] = 6] = "NumberBoxes";
            // repetitive sections
            SectionType[SectionType["Function"] = 32] = "Function";
            SectionType[SectionType["Literal"] = 33] = "Literal";
            SectionType[SectionType["VTable"] = 34] = "VTable";
        })(SectionType || (SectionType = {}));
        // this also handles dates after 2106-02-07 (larger than 2^32 seconds since the beginning of time)
        function encodeTime(d) {
            const t = d.getTime() / 1000;
            return `${t >>> 0}, ${(t / 0x100000000) | 0}`;
        }
        let additionalClassInfos = {};
        function vtName(info) {
            if (!info.classNo)
                additionalClassInfos[info.id] = info;
            return info.id + "_VT";
        }
        function embedVTs() {
            return pxtc.target.useESP;
        }
        function vtRef(vt) {
            if (embedVTs())
                return `0xffffffff, ${vt}`;
            else
                return `0xffffffff, 0xffffffff ; -> ${vt}`;
        }
        function encodeSourceMap(srcmap) {
            // magic: 0x4d435253 0x2d4e1588 0x719986aa ('SRCM' ... )
            const res = [0x53, 0x52, 0x43, 0x4d, 0x88, 0x15, 0x4e, 0x2d, 0xaa, 0x86, 0x99, 0x71, 0x00, 0x00, 0x00, 0x00];
            for (const fn of Object.keys(srcmap)) {
                for (const c of pxtc.U.stringToUint8Array(fn))
                    res.push(c);
                res.push(0);
                const arr = srcmap[fn];
                let prevLn = 0;
                let prevOff = 0;
                for (let i = 0; i < arr.length; i += 3) {
                    encodeNumber(arr[i] - prevLn);
                    encodeNumber((arr[i + 1] - prevOff) >> 1);
                    encodeNumber(arr[i + 2] >> 1);
                    prevLn = arr[i];
                    prevOff = arr[i + 1];
                }
                res.push(0xff); // end-marker
            }
            res.push(0);
            if (res.length & 1)
                res.push(0);
            const res2 = [];
            for (let i = 0; i < res.length; i += 2)
                res2.push(res[i] | (res[i + 1] << 8));
            return res2;
            function encodeNumber(k) {
                if (0 <= k && k < 0xf0)
                    res.push(k);
                else {
                    let mark = 0xf0;
                    if (k < 0) {
                        k = -k;
                        mark |= 0x08;
                    }
                    const idx = res.length;
                    res.push(null); // placeholder
                    let len = 0;
                    while (k != 0) {
                        res.push(k & 0xff);
                        k >>>= 8;
                        len++;
                    }
                    res[idx] = mark | len;
                }
            }
        }
        /* eslint-disable no-trailing-spaces */
        function vmEmit(bin, opts) {
            let vmsource = `; VM start
_img_start:
${pxtc.hexfile.hexPrelude()}
`;
            additionalClassInfos = {};
            const ctx = {
                dblText: [],
                dblBoxText: [],
                dbls: {},
                opcodeMap: {},
                opcodes: pxtc.vm.opcodes.map(o => "pxt::op_" + o.replace(/ .*/, "")),
            };
            ctx.opcodes.unshift(null);
            while (ctx.opcodes.length < 128)
                ctx.opcodes.push(null);
            let address = 0;
            function section(name, tp, body, aliases, aux = 0) {
                vmsource += `
; --- ${name}
.section code
    .set ${name} = ${address}
`;
                if (aliases) {
                    for (let alias of aliases)
                        vmsource += `    .set ${alias} = ${address}\n`;
                }
                vmsource += `
_start_${name}:
    .byte ${tp}, 0x00
    .short ${aux}
    .word _end_${name}-_start_${name}\n`;
                vmsource += body();
                vmsource += `\n.balign 8\n_end_${name}:\n`;
                address++;
            }
            const now = new Date(0); // new Date()
            let encodedName = pxtc.U.toUTF8(opts.name, true);
            if (encodedName.length > 100)
                encodedName = encodedName.slice(0, 100);
            let encodedLength = encodedName.length + 1;
            if (encodedLength & 1)
                encodedLength++;
            const paddingSize = 128 - encodedLength;
            section("_info", SectionType.InfoHeader, () => `
                ; magic - \\0 added by assembler
                .string "\\nPXT64\\n"
                .hex 5471fe2b5e213768 ; magic
                .hex ${pxtc.hexfile.hexTemplateHash()} ; hex template hash
                .hex 0000000000000000 ; @SRCHASH@
                .word ${bin.globalsWords}   ; num. globals
                .word ${bin.nonPtrGlobals} ; non-ptr globals
                .word 0, 0 ; last usage time
                .word ${encodeTime(now)} ; installation time
                .word ${encodeTime(now)} ; publication time - TODO
                .word _img_end-_img_start ; total image size
                .space 60 ; reserved
                .string ${JSON.stringify(encodedName)}
                .space ${paddingSize} ; pad to 128 bytes
`);
            bin.procs.forEach(p => {
                section(p.label(), SectionType.Function, () => irToVM(ctx, bin, p), [p.label() + "_Lit"]);
            });
            vmsource += "_code_end:\n\n";
            vmsource += "_helpers_end:\n\n";
            bin.usedClassInfos.forEach(info => {
                section(vtName(info), SectionType.VTable, () => vtableToVM(info, opts, bin));
            });
            pxtc.U.values(additionalClassInfos).forEach(info => {
                info.itable = [];
                info.classNo = 0xfff0;
                section(vtName(info), SectionType.VTable, () => vtableToVM(info, opts, bin));
            });
            additionalClassInfos = {};
            let idx = 0;
            section("ifaceMemberNames", SectionType.IfaceMemberNames, () => `    .word ${bin.ifaceMembers.length} ; num. entries\n` + bin.ifaceMembers.map(d => `    .word ${bin.emitString(d)}  ; ${idx++} .${d}`).join("\n"));
            vmsource += "_vtables_end:\n\n";
            pxtc.U.iterMap(bin.hexlits, (k, v) => {
                section(v, SectionType.Literal, () => `.word ${vtRef("pxt::buffer_vt")}\n` +
                    pxtc.hexLiteralAsm(k), [], pxt.BuiltInType.BoxedBuffer);
            });
            // ifaceMembers are already sorted alphabetically
            // here we make sure that the pointers to them are also sorted alphabetically
            // by emitting them in order and before everything else
            const keys = pxtc.U.unique(bin.ifaceMembers.concat(Object.keys(bin.strings)), s => s);
            keys.forEach(k => {
                const info = pxtc.utf8AsmStringLiteral(k);
                let tp = pxt.BuiltInType.BoxedString;
                if (info.vt == "pxt::string_inline_ascii_vt")
                    tp = pxt.BuiltInType.BoxedString_ASCII;
                else if (info.vt == "pxt::string_skiplist16_packed_vt")
                    tp = pxt.BuiltInType.BoxedString_SkipList;
                else if (info.vt == "pxt::string_inline_utf8_vt")
                    tp = pxt.BuiltInType.BoxedString;
                else
                    pxtc.oops("invalid vt");
                const text = `.word ${vtRef(info.vt)}\n` +
                    info.asm;
                section(bin.strings[k], SectionType.Literal, () => text, [], tp);
            });
            section("numberBoxes", SectionType.NumberBoxes, () => ctx.dblBoxText.join("\n")
                + "\n.word 0, 0, 0 ; dummy entry to make sure not empty");
            section("numberLiterals", SectionType.NumberLiterals, () => ctx.dblText.join("\n")
                + "\n.word 0, 0 ; dummy entry to make sure not empty");
            const cfg = bin.res.configData || [];
            section("configData", SectionType.ConfigData, () => cfg.map(d => `    .word ${d.key}, ${d.value}  ; ${d.name}=${d.value}`).join("\n")
                + "\n    .word 0, 0");
            let s = ctx.opcodes.map(s => s == null ? "" : s).join("\x00") + "\x00";
            let opcm = "";
            while (s) {
                let pref = s.slice(0, 64);
                s = s.slice(64);
                if (pref.length & 1)
                    pref += "\x00";
                opcm += ".hex " + pxtc.U.toHex(pxtc.U.stringToUint8Array(pref)) + "\n";
            }
            section("opcodeMap", SectionType.OpCodeMap, () => opcm);
            vmsource += "_literals_end:\n";
            vmsource += "_img_end:\n";
            vmsource += "\n; The end.\n";
            bin.writeFile(pxtc.BINARY_ASM, vmsource);
            let res = pxtc.assemble(opts.target, bin, vmsource);
            const srcmap = res.thumbFile.getSourceMap();
            const encodedSrcMap = encodeSourceMap(srcmap);
            if (res.src)
                bin.writeFile(pxtc.BINARY_ASM, `; srcmap size: ${encodedSrcMap.length << 1} bytes\n` + res.src);
            {
                let binstring = "";
                for (let v of res.buf)
                    binstring += String.fromCharCode(v & 0xff, v >> 8);
                const hash = pxtc.U.sha256(binstring);
                for (let i = 0; i < 4; ++i) {
                    res.buf[16 + i] = parseInt(hash.slice(i * 4, i * 4 + 4), 16);
                }
                srcmap["__meta"] = {
                    name: opts.name,
                    programHash: res.buf[16] | (res.buf[16 + 1] << 16),
                    // TODO would be nice to include version number of editor...
                };
            }
            bin.writeFile(pxtc.BINARY_SRCMAP, JSON.stringify(srcmap));
            if (pxt.options.debug) {
                let pc = res.thumbFile.peepCounts;
                let keys = Object.keys(pc);
                keys.sort((a, b) => pc[b] - pc[a]);
                for (let k of keys.slice(0, 50)) {
                    console.log(`${k}  ${pc[k]}`);
                }
            }
            if (res.buf) {
                let binstring = "";
                const buf = res.buf;
                while (buf.length & 0xf)
                    buf.push(0);
                pxtc.U.pushRange(buf, encodedSrcMap);
                for (let v of buf)
                    binstring += String.fromCharCode(v & 0xff, v >> 8);
                binstring = ts.pxtc.encodeBase64(binstring);
                if (embedVTs()) {
                    bin.writeFile(pxtc.BINARY_PXT64, binstring);
                    const patched = pxtc.hexfile.patchHex(bin, buf, false, !!pxtc.target.useUF2)[0];
                    bin.writeFile(pxt.outputName(pxtc.target), ts.pxtc.encodeBase64(patched));
                }
                else {
                    bin.writeFile(pxt.outputName(pxtc.target), binstring);
                }
            }
        }
        pxtc.vmEmit = vmEmit;
        function irToVM(ctx, bin, proc) {
            let resText = "";
            const writeRaw = (s) => { resText += s + "\n"; };
            const write = (s) => { resText += "    " + s + "\n"; };
            const EK = pxtc.ir.EK;
            let alltmps = [];
            let currTmps = [];
            let final = false;
            let numLoc = 0;
            let argDepth = 0;
            const immMax = (1 << 23) - 1;
            if (pxt.options.debug)
                console.log("EMIT", proc.toString());
            emitAll();
            resText = "";
            for (let t of alltmps)
                t.reset();
            final = true;
            pxtc.U.assert(argDepth == 0);
            emitAll();
            return resText;
            function emitAll() {
                writeRaw(`;\n; ${proc.getFullName()}\n;`);
                write(".section code");
                if (bin.procs[0] == proc) {
                    writeRaw(`; main`);
                }
                write(`.word ${vtRef("pxt::RefAction_vtable")}`);
                write(`.short 0, ${proc.args.length} ; #args`);
                write(`.short ${proc.captured.length}, 0 ; #cap`);
                write(`.word .fnstart-_img_start, 0  ; func+possible padding`);
                numLoc = proc.locals.length + currTmps.length;
                write(`.fnstart:`);
                write(`pushmany ${numLoc} ; incl. ${currTmps.length} tmps`);
                for (let s of proc.body) {
                    switch (s.stmtKind) {
                        case pxtc.ir.SK.Expr:
                            emitExpr(s.expr);
                            break;
                        case pxtc.ir.SK.StackEmpty:
                            clearStack();
                            for (let e of currTmps) {
                                if (e) {
                                    pxtc.oops(`uses: ${e.currUses}/${e.totalUses} ${e.toString()}`);
                                }
                            }
                            break;
                        case pxtc.ir.SK.Jmp:
                            emitJmp(s);
                            break;
                        case pxtc.ir.SK.Label:
                            writeRaw(`${s.lblName}:`);
                            break;
                        case pxtc.ir.SK.Comment:
                            writeRaw(`; ${s.expr.data}`);
                            break;
                        case pxtc.ir.SK.Breakpoint:
                            break;
                        default: pxtc.oops();
                    }
                }
                write(`ret ${proc.args.length}, ${numLoc}`);
            }
            function emitJmp(jmp) {
                let trg = jmp.lbl.lblName;
                if (jmp.jmpMode == pxtc.ir.JmpMode.Always) {
                    if (jmp.expr)
                        emitExpr(jmp.expr);
                    write(`jmp ${trg}`);
                }
                else {
                    emitExpr(jmp.expr);
                    if (jmp.jmpMode == pxtc.ir.JmpMode.IfNotZero) {
                        write(`jmpnz ${trg}`);
                    }
                    else if (jmp.jmpMode == pxtc.ir.JmpMode.IfZero) {
                        write(`jmpz ${trg}`);
                    }
                    else {
                        pxtc.oops();
                    }
                }
            }
            function cellref(cell) {
                if (cell.isGlobal()) {
                    pxtc.U.assert((cell.index & 3) == 0);
                    return (`glb ` + (cell.index >> 2) + ` ; ${cell.getName()}`);
                }
                else if (cell.iscap)
                    return (`cap ` + cell.index + ` ; ${cell.getName()}`);
                else if (cell.isarg) {
                    let idx = proc.args.length - cell.index - 1;
                    pxtc.assert(idx >= 0, "arg#" + idx);
                    return (`loc ${argDepth + numLoc + 2 + idx} ; ${cell.getName()}`);
                }
                else {
                    let idx = cell.index + currTmps.length;
                    //console.log(proc.locals.length, currTmps.length, cell.index)
                    pxtc.assert(!final || idx < numLoc, "cell#" + idx);
                    pxtc.assert(idx >= 0, "cell#" + idx);
                    return (`loc ${argDepth + idx}`);
                }
            }
            function callRT(name) {
                const inf = pxtc.hexfile.lookupFunc(name);
                if (!inf)
                    pxtc.U.oops("missing function: " + name);
                let id = ctx.opcodeMap[inf.name];
                if (id == null) {
                    id = ctx.opcodes.length;
                    ctx.opcodes.push(inf.name);
                    ctx.opcodeMap[inf.name] = id;
                    inf.value = id;
                }
                write(`callrt ${name}`);
            }
            function emitInstanceOf(info, tp) {
                if (tp == "bool") {
                    write(`checkinst ${vtName(info)}`);
                }
                else if (tp == "validate") {
                    pxtc.U.oops();
                }
                else {
                    pxtc.U.oops();
                }
            }
            function emitExprInto(e) {
                switch (e.exprKind) {
                    case EK.NumberLiteral:
                        const tagged = pxtc.taggedSpecial(e.data);
                        if (tagged != null)
                            write(`ldspecial ${tagged} ; ${e.data}`);
                        else {
                            let n = e.data;
                            let n0 = 0, n1 = 0;
                            const needsBox = ((n << 1) >> 1) != n; // boxing needed on PXT32?
                            if ((n | 0) == n) {
                                if (Math.abs(n) <= immMax) {
                                    if (n < 0)
                                        write(`ldintneg ${-n}`);
                                    else
                                        write(`ldint ${n}`);
                                    return;
                                }
                                else {
                                    n0 = ((n << 1) | 1) >>> 0;
                                    n1 = n < 0 ? 1 : 0;
                                }
                            }
                            else {
                                let a = new Float64Array(1);
                                a[0] = n;
                                let u = new Uint32Array(a.buffer);
                                u[1] += 0x10000;
                                n0 = u[0];
                                n1 = u[1];
                            }
                            let key = n0 + "," + n1;
                            let id = pxtc.U.lookup(ctx.dbls, key);
                            if (id == null) {
                                id = ctx.dblText.length;
                                ctx.dblText.push(`.word ${n0}, ${n1}  ; ${id}: ${e.data}`);
                                if (needsBox) {
                                    const vt = "pxt::number_vt";
                                    ctx.dblBoxText.push(`.word ${embedVTs() ? vt : `0xffffffff ; ${vt}`}\n`);
                                    let a = new Float64Array(1);
                                    a[0] = n;
                                    let u = new Uint32Array(a.buffer);
                                    ctx.dblBoxText.push(`.word ${u[0]}, ${u[1]} ; ${n}\n`);
                                }
                                ctx.dbls[key] = id;
                            }
                            write(`ldnumber ${id} ; ${e.data}`);
                        }
                        return;
                    case EK.PointerLiteral:
                        write(`ldlit ${e.data}`);
                        return;
                    case EK.SharedRef:
                        let arg = e.args[0];
                        if (!arg.currUses || arg.currUses >= arg.totalUses) {
                            console.log(arg.sharingInfo());
                            pxtc.U.assert(false);
                        }
                        arg.currUses++;
                        let idx = currTmps.indexOf(arg);
                        if (idx < 0) {
                            console.log(currTmps, arg);
                            pxtc.assert(false);
                        }
                        write(`ldloc ${idx + argDepth}` + (arg.currUses == arg.totalUses ? " ; LAST" : ""));
                        clearStack();
                        return;
                    case EK.CellRef:
                        write("ld" + cellref(e.data));
                        return;
                    case EK.InstanceOf:
                        emitExpr(e.args[0]);
                        emitInstanceOf(e.data, e.jsInfo);
                        break;
                    default: throw pxtc.oops("kind: " + e.exprKind);
                }
            }
            // result in R0
            function emitExpr(e) {
                //console.log(`EMITEXPR ${e.sharingInfo()} E: ${e.toString()}`)
                switch (e.exprKind) {
                    case EK.JmpValue:
                        write("; jmp value (already in r0)");
                        break;
                    case EK.Nop:
                        write("; nop");
                        break;
                    case EK.FieldAccess:
                        let info = e.data;
                        emitExpr(e.args[0]);
                        write(`ldfld ${info.idx}, ${vtName(info.classInfo)}`);
                        break;
                    case EK.Store:
                        return emitStore(e.args[0], e.args[1]);
                    case EK.RuntimeCall:
                        return emitRtCall(e);
                    case EK.ProcCall:
                        return emitProcCall(e);
                    case EK.SharedDef:
                        return emitSharedDef(e);
                    case EK.Sequence:
                        return e.args.forEach(emitExpr);
                    default:
                        return emitExprInto(e);
                }
            }
            function emitSharedDef(e) {
                let arg = e.args[0];
                pxtc.U.assert(arg.totalUses >= 1);
                pxtc.U.assert(arg.currUses === 0);
                arg.currUses = 1;
                alltmps.push(arg);
                if (arg.totalUses == 1)
                    return emitExpr(arg);
                else {
                    emitExpr(arg);
                    let idx = -1;
                    for (let i = 0; i < currTmps.length; ++i)
                        if (currTmps[i] == null) {
                            idx = i;
                            break;
                        }
                    if (idx < 0) {
                        if (final) {
                            console.log(arg, currTmps);
                            pxtc.assert(false, "missed tmp");
                        }
                        idx = currTmps.length;
                        currTmps.push(arg);
                    }
                    else {
                        currTmps[idx] = arg;
                    }
                    write(`stloc ${idx + argDepth}`);
                }
            }
            function push() {
                write(`push`);
                argDepth++;
            }
            function emitRtCall(topExpr) {
                let name = topExpr.data;
                if (name == "pxt::beginTry") {
                    write(`try ${topExpr.args[0].data}`);
                    return;
                }
                name = pxtc.U.lookup(vmCallMap, name) || name;
                clearStack();
                let spec = pxtc.U.lookup(vmSpecOpcodes, name);
                let args = topExpr.args;
                let numPush = 0;
                if (name == "pxt::mkClassInstance") {
                    write(`newobj ${args[0].data}`);
                    return;
                }
                for (let i = 0; i < args.length; ++i) {
                    emitExpr(args[i]);
                    if (i < args.length - 1) {
                        push();
                        numPush++;
                    }
                }
                //let inf = hex.lookupFunc(name)
                if (name == "langsupp::ignore") {
                    if (numPush)
                        write(`popmany ${numPush} ; ignore`);
                }
                else if (spec) {
                    write(spec);
                }
                else {
                    callRT(name);
                }
                argDepth -= numPush;
            }
            function clearStack() {
                for (let i = 0; i < currTmps.length; ++i) {
                    let e = currTmps[i];
                    if (e && e.currUses == e.totalUses) {
                        if (!final)
                            alltmps.push(e);
                        currTmps[i] = null;
                    }
                }
            }
            function emitProcCall(topExpr) {
                let calledProcId = topExpr.data;
                let calledProc = calledProcId.proc;
                if (calledProc && calledProc.inlineBody) {
                    const inlined = calledProc.inlineSelf(topExpr.args);
                    if (pxt.options.debug) {
                        console.log("INLINE", topExpr.toString(), "->", inlined.toString());
                    }
                    return emitExpr(inlined);
                }
                let numPush = 0;
                const args = topExpr.args.slice();
                const lambdaArg = calledProcId.virtualIndex == -1 ? args.shift() : null;
                for (let e of args) {
                    emitExpr(e);
                    push();
                    numPush++;
                }
                let nargs = args.length;
                if (lambdaArg) {
                    emitExpr(lambdaArg);
                    write(`callind ${nargs}`);
                }
                else if (calledProcId.ifaceIndex != null) {
                    let idx = calledProcId.ifaceIndex + " ; ." + bin.ifaceMembers[calledProcId.ifaceIndex];
                    if (calledProcId.isSet) {
                        write(`callset ${idx}`);
                        pxtc.U.assert(nargs == 2);
                    }
                    else if (calledProcId.noArgs) {
                        // TODO implementation of op_callget needs to auto-bind if needed
                        write(`callget ${idx}`);
                        pxtc.U.assert(nargs == 1);
                    }
                    else {
                        // TODO impl of op_calliface needs to call getter and then the lambda if needed
                        write(`calliface ${nargs}, ${idx}`);
                    }
                }
                else if (calledProcId.virtualIndex != null) {
                    pxtc.U.oops();
                }
                else {
                    write(`callproc ${calledProc.label()}`);
                }
                argDepth -= numPush;
            }
            function emitStore(trg, src) {
                switch (trg.exprKind) {
                    case EK.CellRef:
                        emitExpr(src);
                        let cell = trg.data;
                        let instr = "st" + cellref(cell);
                        if (cell.isGlobal() && (cell.bitSize != 0 /* None */)) {
                            const enc = pxtc.sizeOfBitSize(cell.bitSize) |
                                (pxtc.isBitSizeSigned(cell.bitSize) ? 0x10 : 0x00);
                            write("bitconv " + enc);
                        }
                        write(instr);
                        break;
                    case EK.FieldAccess:
                        let info = trg.data;
                        emitExpr(trg.args[0]);
                        push();
                        emitExpr(src);
                        write(`stfld ${info.idx}, ${vtName(info.classInfo)}`);
                        argDepth--;
                        break;
                    default: pxtc.oops();
                }
            }
        }
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        var decompiler;
        (function (decompiler) {
            let DecompileParamKeys;
            (function (DecompileParamKeys) {
                // Field editor should decompile literal expressions in addition to
                // call expressions
                DecompileParamKeys["DecompileLiterals"] = "decompileLiterals";
                // Tagged template name expected by a field editor for a parameter
                // (i.e. for tagged templates with blockIdentity set)
                DecompileParamKeys["TaggedTemplate"] = "taggedTemplate";
                // Allow for arguments for which fixed instances exist to be decompiled
                // even if the expression is not a direct reference to a fixed instance
                DecompileParamKeys["DecompileIndirectFixedInstances"] = "decompileIndirectFixedInstances";
                // When set on a function, the argument expression will be passed up
                // as a string of TypeScript code instead of being decompiled into blocks. The
                // field editor is expected to parse the code itself and also preserve it
                // if the valus is invalid (like a grey-block would)
                DecompileParamKeys["DecompileArgumentAsString"] = "decompileArgumentAsString";
            })(DecompileParamKeys = decompiler.DecompileParamKeys || (decompiler.DecompileParamKeys = {}));
            let CommentKind;
            (function (CommentKind) {
                CommentKind[CommentKind["SingleLine"] = 0] = "SingleLine";
                CommentKind[CommentKind["MultiLine"] = 1] = "MultiLine";
            })(CommentKind = decompiler.CommentKind || (decompiler.CommentKind = {}));
            decompiler.FILE_TOO_LARGE_CODE = 9266;
            decompiler.DECOMPILER_ERROR = 9267;
            const SK = ts.SyntaxKind;
            /**
             * Max number of blocks before we bail out of decompilation
             */
            const MAX_BLOCKS = 1500;
            const lowerCaseAlphabetStartCode = 97;
            const lowerCaseAlphabetEndCode = 122;
            // Bounds for decompilation of workspace comments
            const minCommentWidth = 160;
            const minCommentHeight = 120;
            const maxCommentWidth = 480;
            const maxCommentHeight = 360;
            const validStringRegex = /^[^\f\n\r\t\v\u00a0\u1680\u180e\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$/;
            const arrayTypeRegex = /^(?:Array<(.+)>)|(?:(.+)\[\])$/;
            const numberType = "math_number";
            const minmaxNumberType = "math_number_minmax";
            const integerNumberType = "math_integer";
            const wholeNumberType = "math_whole_number";
            const stringType = "text";
            const booleanType = "logic_boolean";
            const ops = {
                "+": { type: "math_arithmetic", op: "ADD" },
                "-": { type: "math_arithmetic", op: "MINUS" },
                "/": { type: "math_arithmetic", op: "DIVIDE" },
                "*": { type: "math_arithmetic", op: "MULTIPLY" },
                "**": { type: "math_arithmetic", op: "POWER" },
                "%": { type: "math_modulo", leftName: "DIVIDEND", rightName: "DIVISOR" },
                "<": { type: "logic_compare", op: "LT" },
                "<=": { type: "logic_compare", op: "LTE" },
                ">": { type: "logic_compare", op: "GT" },
                ">=": { type: "logic_compare", op: "GTE" },
                "==": { type: "logic_compare", op: "EQ" },
                "===": { type: "logic_compare", op: "EQ" },
                "!=": { type: "logic_compare", op: "NEQ" },
                "!==": { type: "logic_compare", op: "NEQ" },
                "&&": { type: "logic_operation", op: "AND" },
                "||": { type: "logic_operation", op: "OR" },
            };
            /*
             * Matches a single line comment and extracts the text.
             * Breakdown:
             *     ^\s*     - matches leading whitespace
             *      \/\/s*  - matches double slash
             *      (.*)    - matches rest of the comment
             */
            const singleLineCommentRegex = /^\s*\/\/\s*(.*)$/;
            /*
             * Matches one line of a multi-line comment and extracts the text.
             * Breakdown:
             *      ^\s*                                        - matches leading whitespace
             *      (?:\/\*\*?)                                 - matches beginning of a multi-line comment (/* or /**)
             *      (?:\*)                                      - matches a single asterisk that might begin a line in the body of the comment
             *      (?:(?:(?:\/\*\*?)|(?:\*))(?!\/))            - combines the previous two regexes but does not match either if followed by a slash
             *      ^\s*(?:(?:(?:\/\*\*?)|(?:\*))(?!\/))?\s*    - matches all possible beginnings of a multi-line comment line (/*, /**, *, or just whitespace)
             *      (.*?)                                       - matches the text of the comment line
             *      (?:\*?\*\/)?$                               - matches the end of the multiline comment (one or two asterisks and a slash) or the end of a line within the comment
             */
            const multiLineCommentRegex = /^\s*(?:(?:(?:\/\*\*?)|(?:\*))(?!\/))?\s*(.*?)(?:\*?\*\/)?$/;
            class RenameMap {
                constructor(renames) {
                    this.renames = renames;
                    this.renames.sort((a, b) => a.span.start - b.span.start);
                }
                getRenamesInSpan(start, end) {
                    const res = [];
                    for (const rename of this.renames) {
                        if (rename.span.start > end) {
                            break;
                        }
                        else if (rename.span.start >= start) {
                            res.push(rename);
                        }
                    }
                    return res;
                }
                getRenameForPosition(position) {
                    for (const rename of this.renames) {
                        if (rename.span.start > position) {
                            return undefined;
                        }
                        else if (rename.span.start === position) {
                            return rename;
                        }
                    }
                    return undefined;
                }
            }
            decompiler.RenameMap = RenameMap;
            /**
             * Uses the language service to ensure that there are no duplicate variable
             * names in the given file. All variables in Blockly are global, so this is
             * necessary to prevent local variables from colliding.
             */
            function buildRenameMap(p, s, { declarations, takenNames } = { declarations: "variables", takenNames: {} }) {
                let service = ts.createLanguageService(new pxtc.LSHost(p));
                const allRenames = [];
                let names = collectNameCollisions();
                return [new RenameMap(allRenames), names];
                function collectNameCollisions() {
                    checkChildren(s);
                    function checkChildren(n) {
                        ts.forEachChild(n, (child) => {
                            if (ts.isDeclarationName(child)
                                && (declarations === "all" || ts.isVariableDeclaration(child.parent))) {
                                const name = child.getText();
                                if (takenNames[name]) {
                                    const newName = getNewName(name, takenNames);
                                    const renames = service.findRenameLocations(s.fileName, child.pos + 1, false, false);
                                    if (renames) {
                                        renames.forEach(r => {
                                            allRenames.push({
                                                name: newName,
                                                diff: newName.length - name.length,
                                                span: r.textSpan
                                            });
                                        });
                                    }
                                }
                                else {
                                    takenNames[name] = true;
                                }
                            }
                            checkChildren(child);
                        });
                    }
                    return takenNames;
                }
            }
            decompiler.buildRenameMap = buildRenameMap;
            function getNewName(name, takenNames, recordNewName = true) {
                // If the variable is a single lower case letter, try and rename it to a different letter (i.e. i -> j)
                // DO NOT apply this logic to variables named x, y, or z since those are generally meaningful names
                if (name.length === 1 && name !== "x" && name !== "y" && name !== "z") {
                    const charCode = name.charCodeAt(0);
                    if (charCode >= lowerCaseAlphabetStartCode && charCode <= lowerCaseAlphabetEndCode) {
                        const offset = charCode - lowerCaseAlphabetStartCode;
                        for (let i = 1; i < 26; i++) {
                            const newChar = String.fromCharCode(lowerCaseAlphabetStartCode + ((offset + i) % 26));
                            if (newChar === "x" || newChar === "y" || newChar === "z")
                                continue;
                            if (!takenNames[newChar]) {
                                if (recordNewName)
                                    takenNames[newChar] = true;
                                return newChar;
                            }
                        }
                    }
                }
                // For all other names, add a number to the end. Start at 2 because it probably makes more sense for kids
                for (let i = 2;; i++) {
                    const toTest = name + i;
                    if (!takenNames[toTest]) {
                        if (recordNewName)
                            takenNames[toTest] = true;
                        return toTest;
                    }
                }
            }
            decompiler.getNewName = getNewName;
            let ReferenceType;
            (function (ReferenceType) {
                // Variable is never referenced
                ReferenceType[ReferenceType["None"] = 0] = "None";
                // Variable is only referenced in "non-grey" blocks
                ReferenceType[ReferenceType["InBlocksOnly"] = 1] = "InBlocksOnly";
                // Variable is referenced at least once inside "grey" blocks
                ReferenceType[ReferenceType["InTextBlocks"] = 2] = "InTextBlocks";
            })(ReferenceType || (ReferenceType = {}));
            function decompileToBlocks(blocksInfo, file, options, renameMap) {
                let emittedBlocks = 0;
                let stmts = file.statements;
                const result = {
                    blocksInfo: blocksInfo,
                    outfiles: {},
                    diagnostics: [],
                    success: true,
                    times: {}
                };
                if (options.generateSourceMap)
                    result.blockSourceMap = [];
                const env = {
                    blocks: blocksInfo,
                    declaredFunctions: {},
                    declaredEnums: {},
                    declaredKinds: {},
                    functionParamIds: {},
                    attrs: attrs,
                    compInfo: compInfo,
                    localReporters: [],
                    tileset: [],
                    opts: options || {},
                    aliasBlocks: {}
                };
                const fileText = file.getFullText();
                let output = "";
                const enumMembers = [];
                const varUsages = {};
                const workspaceComments = [];
                const autoDeclarations = [];
                const getCommentRef = (() => { let currentCommentId = 0; return () => `${currentCommentId++}`; })();
                const apis = blocksInfo.apis.byQName;
                Object.keys(apis).forEach(qName => {
                    const api = apis[qName];
                    if (api.attributes.blockAliasFor && apis[api.attributes.blockAliasFor]) {
                        env.aliasBlocks[api.attributes.blockAliasFor] = api.qName;
                    }
                });
                const commentMap = buildCommentMap(file);
                const checkTopNode = (topLevelNode) => {
                    if (topLevelNode.kind === SK.FunctionDeclaration && !checkStatement(topLevelNode, env, false, true)) {
                        env.declaredFunctions[getVariableName(topLevelNode.name)] = topLevelNode;
                    }
                    else if (topLevelNode.kind === SK.EnumDeclaration && !checkStatement(topLevelNode, env, false, true)) {
                        const enumName = topLevelNode.name.text;
                        env.declaredEnums[enumName] = true;
                        getEnumMembers(topLevelNode).forEach(([name, value]) => {
                            // We add the value to the front of the name because it needs to be maintained
                            // across compilation/decompilation just in case the code relies on the actual value.
                            // It's safe to do because enum members can't start with numbers.
                            enumMembers.push({
                                name: value + name,
                                type: enumName
                            });
                        });
                    }
                    else if (ts.isModuleDeclaration(topLevelNode)) {
                        if (!checkKindNamespaceDeclaration(topLevelNode, env)) {
                            const kindName = topLevelNode.name.text;
                            const exported = getModuleExports(topLevelNode);
                            if (env.declaredKinds[kindName]) {
                                env.declaredKinds[kindName].declaredNames.push(...(exported.map(({ name }) => name)));
                            }
                        }
                        else if (!checkTilesetNamespace(topLevelNode)) {
                            env.tileset = getModuleExports(topLevelNode).map(({ name, initializer }) => ({
                                projectId: parseInt(name.substr(pxt.sprite.TILE_PREFIX.length)),
                                data: pxt.sprite.imageLiteralToBitmap(initializer).data()
                            }));
                        }
                    }
                    else if (topLevelNode.kind === SK.Block) {
                        ts.forEachChild(topLevelNode, checkTopNode);
                    }
                };
                Object.keys(blocksInfo.kindsByName).forEach(k => {
                    const kindInfo = blocksInfo.kindsByName[k];
                    env.declaredKinds[k] = { kindInfo, declaredNames: [] };
                });
                ts.forEachChild(file, checkTopNode);
                // Generate fresh param IDs for all user-declared functions, needed when decompiling
                // function definition and calls. IDs don't need to be crypto secure.
                const genId = () => (Math.PI * Math.random()).toString(36).slice(2);
                Object.keys(env.declaredFunctions).forEach(funcName => {
                    env.functionParamIds[funcName] = {};
                    env.declaredFunctions[funcName].parameters.forEach(p => {
                        env.functionParamIds[funcName][p.name.getText()] = genId() + genId();
                    });
                });
                Object.keys(env.declaredKinds).forEach(kindName => {
                    const kindType = "KIND_" + kindName;
                    env.declaredKinds[kindName].declaredNames.forEach(kindMember => enumMembers.push({
                        name: kindMember,
                        type: kindType
                    }));
                });
                if (enumMembers.length || env.tileset.length) {
                    write("<variables>");
                    enumMembers.forEach(e => {
                        write(`<variable type="${pxtc.U.htmlEscape(e.type)}">${pxtc.U.htmlEscape(e.name)}</variable>`);
                    });
                    env.tileset.forEach(e => {
                        write(`<variable type="${pxt.sprite.BLOCKLY_TILESET_TYPE}">${pxt.sprite.legacy.tileToBlocklyVariable(e)}</variable>`);
                    });
                    write("</variables>");
                }
                let n;
                try {
                    n = codeBlock(stmts, undefined, true, undefined, !options.snippetMode);
                    // Emit all of the orphaned comments
                    for (const comment of commentMap) {
                        if (!comment.owner) {
                            workspaceComments.push({
                                refId: getCommentRef(),
                                comment: [comment]
                            });
                        }
                    }
                }
                catch (e) {
                    if (e.programTooLarge) {
                        result.success = false;
                        result.diagnostics = pxtc.patchUpDiagnostics([{
                                file,
                                start: file.getFullStart(),
                                length: file.getFullWidth(),
                                messageText: e.message,
                                category: ts.DiagnosticCategory.Error,
                                code: decompiler.FILE_TOO_LARGE_CODE
                            }]);
                    }
                    else {
                        // don't throw
                        pxt.reportException(e);
                        result.success = false;
                        result.diagnostics = pxtc.patchUpDiagnostics([{
                                file,
                                start: file.getFullStart(),
                                length: file.getFullWidth(),
                                messageText: e.message,
                                category: ts.DiagnosticCategory.Error,
                                code: decompiler.DECOMPILER_ERROR
                            }]);
                        return result;
                    }
                }
                if (n) {
                    emitStatementNode(n);
                }
                else if (!options.snippetMode && !stmts.length) {
                    openBlockTag(ts.pxtc.ON_START_TYPE, mkStmt(ts.pxtc.ON_START_TYPE, stmts[0]));
                    closeBlockTag();
                }
                workspaceComments.forEach(c => {
                    emitWorkspaceComment(c);
                });
                result.outfiles[file.fileName.replace(/(\.blocks)?\.\w*$/i, '') + '.blocks'] = `<xml xmlns="http://www.w3.org/1999/xhtml">
${output}</xml>`;
                return result;
                function write(s, suffix = "\n") {
                    output += s + suffix;
                }
                function error(n, msg) {
                    const messageText = msg || `Language feature "${n.getFullText().trim()}"" not supported in blocks`;
                    const diags = pxtc.patchUpDiagnostics([{
                            file: file,
                            start: n.getFullStart(),
                            length: n.getFullWidth(),
                            messageText,
                            category: ts.DiagnosticCategory.Error,
                            code: 1001
                        }]);
                    pxt.debug(`decompilation error: ${messageText}`);
                    pxtc.U.pushRange(result.diagnostics, diags);
                    result.success = false;
                }
                function attrs(callInfo) {
                    const blockInfo = blocksInfo.apis.byQName[callInfo.decompilerBlockAlias || callInfo.qName];
                    if (blockInfo) {
                        const attributes = blockInfo.attributes;
                        // Check to make sure this block wasn't filtered out (bannedCategories)
                        if (!attributes.blockId || blocksInfo.blocksById[attributes.blockId] || attributes.blockId === pxtc.PAUSE_UNTIL_TYPE) {
                            return blockInfo.attributes;
                        }
                    }
                    else if (callInfo.decl) {
                        const parsed = pxtc.parseComments(callInfo.decl);
                        if (parsed)
                            return parsed;
                    }
                    return {
                        paramDefl: {},
                        callingConvention: 0 /* Plain */
                    };
                }
                function compInfo(callInfo) {
                    const blockInfo = blocksInfo.apis.byQName[callInfo.qName];
                    if (blockInfo) {
                        return pxt.blocks.compileInfo(blockInfo);
                    }
                    return undefined;
                }
                function countBlock() {
                    emittedBlocks++;
                    if (emittedBlocks > MAX_BLOCKS) {
                        let e = new Error(pxtc.Util.lf("Could not decompile because the script is too large"));
                        e.programTooLarge = true;
                        throw e;
                    }
                }
                // generated ids with the same entropy as blockly
                function blocklyGenUid() {
                    const soup_ = '!#$%()*+,-./:;=?@[]^_`{|}~ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                    const length = 20;
                    const soupLength = soup_.length;
                    const id = [];
                    for (let i = 0; i < length; i++) {
                        id[i] = soup_.charAt(Math.random() * soupLength);
                    }
                    return id.join('');
                }
                function mkId(type, node) {
                    if (type == ts.pxtc.ON_START_TYPE)
                        return "xRRgvHNlG#rZ^u`HECiY";
                    const id = blocklyGenUid();
                    if (node) {
                        const startPos = node.getFullStart();
                        result.blockSourceMap.push({
                            id,
                            startPos,
                            endPos: startPos + node.getFullWidth()
                        });
                    }
                    return id;
                }
                function mkStmt(type, node) {
                    const stm = {
                        kind: "statement",
                        type
                    };
                    if (result.blockSourceMap)
                        stm.id = mkId(type, node);
                    return stm;
                }
                function mkExpr(type, node) {
                    const expr = {
                        kind: "expr",
                        type
                    };
                    //if (result.blockSourceMap)
                    //    expr.id = mkId(type, node);
                    return expr;
                }
                function mkValue(name, value, shadowType, shadowMutation) {
                    if ((!shadowType || shadowType === numberType) && shadowMutation && shadowMutation['min'] && shadowMutation['max']) {
                        // Convert a number to a number with a slider (math_number_minmax) if min and max shadow options are defined
                        shadowType = minmaxNumberType;
                    }
                    return { kind: "value", name, value, shadowType, shadowMutation };
                }
                function isEventExpression(expr) {
                    if (expr.expression.kind == SK.CallExpression) {
                        const call = expr.expression;
                        const callInfo = pxtc.pxtInfo(call).callInfo;
                        if (!callInfo) {
                            error(expr);
                            return false;
                        }
                        const attributes = attrs(callInfo);
                        return attributes.blockId && !attributes.handlerStatement && !callInfo.isExpression && hasStatementInput(callInfo, attributes);
                    }
                    return false;
                }
                function emitStatementNode(n) {
                    if (!n) {
                        return;
                    }
                    openBlockTag(n.type, n);
                    emitBlockNodeCore(n);
                    if (n.data !== undefined) {
                        write(`<data>${pxtc.U.htmlEscape(n.data)}</data>`);
                    }
                    if (n.handlers) {
                        n.handlers.forEach(emitHandler);
                    }
                    if (n.next) {
                        write("<next>");
                        emitStatementNode(n.next);
                        write("</next>");
                    }
                    if (n.comment !== undefined) {
                        write(`<comment pinned="false">${pxtc.U.htmlEscape(formatCommentsForBlocks(n.comment))}</comment>`);
                    }
                    closeBlockTag();
                }
                function emitMutation(mMap, mChildren) {
                    write("<mutation ", "");
                    Object.keys(mMap).forEach(key => {
                        if (mMap[key] !== undefined) {
                            write(`${key}="${mMap[key]}" `, "");
                        }
                    });
                    if (mChildren) {
                        write(">");
                        mChildren.forEach(c => {
                            write(`<${c.nodeName} `, "");
                            Object.keys(c.attributes).forEach(attrName => {
                                write(`${attrName}="${c.attributes[attrName]}" `, "");
                            });
                            write("/>");
                        });
                        write("</mutation>");
                    }
                    else {
                        write("/>");
                    }
                }
                function emitBlockNodeCore(n) {
                    if (n.mutation) {
                        emitMutation(n.mutation, n.mutationChildren);
                    }
                    if (n.fields) {
                        n.fields.forEach(emitFieldNode);
                    }
                    if (n.inputs) {
                        n.inputs.forEach(emitValueNode);
                    }
                }
                function emitValueNode(n) {
                    write(`<value name="${n.name}">`);
                    if (shouldEmitShadowOnly(n)) {
                        emitOutputNode(n.value, true);
                    }
                    else {
                        // Emit a shadow block to appear if the given input is removed
                        if (n.shadowType !== undefined) {
                            switch (n.shadowType) {
                                case numberType:
                                case integerNumberType:
                                case wholeNumberType:
                                    write(`<shadow type="${n.shadowType}"><field name="NUM">0</field></shadow>`);
                                    break;
                                case minmaxNumberType:
                                    write(`<shadow type="${minmaxNumberType}">`);
                                    if (n.shadowMutation) {
                                        emitMutation(n.shadowMutation);
                                    }
                                    write(`<field name="SLIDER">0</field></shadow>`);
                                    break;
                                case booleanType:
                                    write(`<shadow type="${booleanType}"><field name="BOOL">TRUE</field></shadow>`);
                                    break;
                                case stringType:
                                    write(`<shadow type="${stringType}"><field name="TEXT"></field></shadow>`);
                                    break;
                                default:
                                    write(`<shadow type="${n.shadowType}"/>`);
                            }
                        }
                        emitOutputNode(n.value);
                    }
                    write(`</value>`);
                }
                function emitFieldNode(n) {
                    write(`<field name="${pxtc.U.htmlEscape(n.name)}">${pxtc.U.htmlEscape(n.value.toString())}</field>`);
                }
                function emitHandler(h) {
                    write(`<statement name="${pxtc.U.htmlEscape(h.name)}">`);
                    emitStatementNode(h.statement);
                    write(`</statement>`);
                }
                function emitOutputNode(n, shadow = false) {
                    if (n.kind === "text") {
                        const node = n;
                        write(node.value);
                    }
                    else {
                        const node = n;
                        const isShadow = shadow || node.isShadow;
                        const tag = isShadow ? "shadow" : "block";
                        if (!isShadow) {
                            countBlock();
                        }
                        write(`<${tag} ${node.id ? `id="${node.id}" ` : ''}type="${pxtc.U.htmlEscape(node.type)}">`);
                        emitBlockNodeCore(node);
                        write(`</${tag}>`);
                    }
                }
                function openBlockTag(type, node) {
                    countBlock();
                    const id = node && node.id;
                    write(`<block ${id ? `id="${node.id}" ` : ''}type="${pxtc.U.htmlEscape(type)}">`);
                }
                function closeBlockTag() {
                    write(`</block>`);
                }
                function emitWorkspaceComment(comment) {
                    let maxLineLength = 0;
                    const text = formatCommentsForBlocks(comment.comment);
                    if (text.trim()) {
                        const lines = text.split("\n");
                        lines.forEach(line => maxLineLength = Math.max(maxLineLength, line.length));
                        // These are just approximations but they are the best we can do outside the DOM
                        const width = Math.max(Math.min(maxLineLength * 10, maxCommentWidth), minCommentWidth);
                        const height = Math.max(Math.min(lines.length * 40, maxCommentHeight), minCommentHeight);
                        write(`<comment h="${height}" w="${width}" data="${pxtc.U.htmlEscape(comment.refId)}">`);
                        write(pxtc.U.htmlEscape(text));
                        write(`</comment>`);
                    }
                }
                function getOutputBlock(n) {
                    if (checkExpression(n, env)) {
                        return getTypeScriptExpressionBlock(n);
                    }
                    else {
                        switch (n.kind) {
                            case SK.ExpressionStatement:
                                return getOutputBlock(n.expression);
                            case SK.ParenthesizedExpression:
                                return getOutputBlock(n.expression);
                            case SK.Identifier:
                                return getIdentifier(n);
                            case SK.StringLiteral:
                            case SK.FirstTemplateToken:
                            case SK.NoSubstitutionTemplateLiteral:
                                return getStringLiteral(n.text);
                            case SK.NumericLiteral:
                                return getNumericLiteral(n.text);
                            case SK.TrueKeyword:
                                return getBooleanLiteral(true);
                            case SK.FalseKeyword:
                                return getBooleanLiteral(false);
                            case SK.BinaryExpression:
                                return getBinaryExpression(n);
                            case SK.PrefixUnaryExpression:
                                return getPrefixUnaryExpression(n);
                            case SK.PropertyAccessExpression:
                                return getPropertyAccessExpression(n);
                            case SK.ArrayLiteralExpression:
                                return getArrayLiteralExpression(n);
                            case SK.ElementAccessExpression:
                                return getElementAccessExpression(n);
                            case SK.TaggedTemplateExpression:
                                return getTaggedTemplateExpression(n);
                            case SK.CallExpression:
                                return getStatementBlock(n, undefined, undefined, true);
                            case SK.AsExpression:
                                return getOutputBlock(n.expression);
                            default:
                                error(n, pxtc.Util.lf("Unsupported syntax kind for output expression block: {0}", SK[n.kind]));
                                break;
                        }
                        return undefined;
                    }
                }
                function applyRenamesInRange(text, start, end) {
                    if (renameMap) {
                        const renames = renameMap.getRenamesInSpan(start, end);
                        if (renames.length) {
                            let offset = 0;
                            renames.forEach(rename => {
                                const sIndex = rename.span.start + offset - start;
                                const eIndex = sIndex + rename.span.length;
                                offset += rename.diff;
                                text = text.slice(0, sIndex) + rename.name + text.slice(eIndex);
                            });
                        }
                    }
                    return text;
                }
                function getTypeScriptExpressionBlock(n) {
                    const text = applyRenamesInRange(n.getFullText(), n.getFullStart(), n.getEnd()).trim();
                    trackVariableUsagesInText(n);
                    // Mark comments or else they are emitted twice
                    markCommentsInRange(n, commentMap);
                    return getFieldBlock(pxtc.TS_OUTPUT_TYPE, "EXPRESSION", text);
                }
                function getBinaryExpression(n) {
                    const op = n.operatorToken.getText();
                    const npp = ops[op];
                    // Could be string concatenation
                    if (isTextJoin(n)) {
                        return getTextJoin(n);
                    }
                    const leftName = npp.leftName || "A";
                    const rightName = npp.rightName || "B";
                    let leftValue;
                    let rightValue;
                    if (op === "&&" || op === "||") {
                        leftValue = getConditionalInput(leftName, n.left);
                        rightValue = getConditionalInput(rightName, n.right);
                    }
                    else {
                        leftValue = getValue(leftName, n.left, numberType);
                        rightValue = getValue(rightName, n.right, numberType);
                    }
                    const r = mkExpr(npp.type, n);
                    r.fields = [];
                    if (npp.op) {
                        r.fields.push(getField("OP", npp.op));
                    }
                    r.inputs = [leftValue, rightValue];
                    return r;
                }
                function isTextJoin(n) {
                    if (n.kind === SK.BinaryExpression) {
                        const b = n;
                        if (b.operatorToken.getText() === "+" || b.operatorToken.kind == SK.PlusEqualsToken) {
                            const info = pxtc.pxtInfo(n).exprInfo;
                            return !!info;
                        }
                    }
                    return false;
                }
                function collectTextJoinArgs(n, result) {
                    if (isTextJoin(n)) {
                        collectTextJoinArgs(n.left, result);
                        collectTextJoinArgs(n.right, result);
                    }
                    else {
                        result.push(n);
                    }
                }
                function getTextJoin(n) {
                    const args = [];
                    collectTextJoinArgs(n, args);
                    const inputs = [];
                    for (let i = 0; i < args.length; i++) {
                        if (i > 0 || !isEmptyString(args[i].getText())) {
                            inputs.push(getValue("ADD" + inputs.length, args[i], stringType));
                        }
                    }
                    const r = mkExpr("text_join", n);
                    r.inputs = inputs;
                    r.mutation = {
                        "items": inputs.length.toString()
                    };
                    return r;
                }
                function getValue(name, contents, shadowType, shadowMutation) {
                    let value;
                    if (typeof contents === "number") {
                        value = getNumericLiteral(contents.toString());
                    }
                    else if (typeof contents === "boolean") {
                        value = getBooleanLiteral(contents);
                    }
                    else if (typeof contents === "string") {
                        value = getStringLiteral(contents);
                    }
                    else {
                        value = getOutputBlock(contents);
                    }
                    if (value.kind == "expr" && value.type == "math_number") {
                        const actualValue = value.fields[0].value;
                        if (shadowType == "math_integer" && actualValue % 1 === 0)
                            value.type = "math_integer";
                        if (shadowType == "math_whole_number" && actualValue % 1 === 0 && actualValue > 0)
                            value.type = "math_whole_number";
                    }
                    return mkValue(name, value, shadowType, shadowMutation);
                }
                function getIdentifier(identifier) {
                    if (isDeclaredElsewhere(identifier)) {
                        const info = pxtc.pxtInfo(identifier);
                        const id = blocksInfo.apis.byQName[info.commentAttrs.blockIdentity];
                        return getEnumFieldBlock(id, info.commentAttrs.enumIdentity);
                    }
                    const name = getVariableName(identifier);
                    const oldName = identifier.text;
                    let localReporterArg = null;
                    env.localReporters.some(scope => {
                        for (let i = 0; i < scope.length; ++i) {
                            if (scope[i].name === oldName) {
                                localReporterArg = scope[i];
                                return true;
                            }
                        }
                        return false;
                    });
                    if (localReporterArg) {
                        return getDraggableReporterBlock(name, localReporterArg.type, false);
                    }
                    else {
                        trackVariableUsage(name, ReferenceType.InBlocksOnly);
                        return getFieldBlock("variables_get", "VAR", name);
                    }
                }
                function getNumericLiteral(value) {
                    return getFieldBlock("math_number", "NUM", value);
                }
                function getStringLiteral(value) {
                    return getFieldBlock("text", "TEXT", value);
                }
                function getBooleanLiteral(value) {
                    return getFieldBlock("logic_boolean", "BOOL", value ? "TRUE" : "FALSE");
                }
                function getFieldBlock(type, fieldName, value, isShadow) {
                    const r = mkExpr(type, null);
                    r.fields = [getField(fieldName, value)];
                    r.isShadow = isShadow;
                    return r;
                }
                function getDraggableVariableBlock(valueName, varName) {
                    return mkValue(valueName, getFieldBlock("variables_get_reporter", "VAR", varName, true), "variables_get_reporter");
                }
                function mkDraggableReporterValue(valueName, varName, varType) {
                    const reporterType = pxt.blocks.reporterTypeForArgType(varType);
                    const reporterShadowBlock = getDraggableReporterBlock(varName, varType, true);
                    return mkValue(valueName, reporterShadowBlock, reporterType);
                }
                function getDraggableReporterBlock(varName, varType, shadow) {
                    const reporterType = pxt.blocks.reporterTypeForArgType(varType);
                    const reporterShadowBlock = getFieldBlock(reporterType, "VALUE", varName, shadow);
                    if (reporterType === "argument_reporter_custom") {
                        reporterShadowBlock.mutation = { typename: varType };
                    }
                    return reporterShadowBlock;
                }
                function getField(name, value) {
                    return {
                        kind: "field",
                        name,
                        value,
                    };
                }
                // TODO: Add a real negation block
                function negateNumericNode(node) {
                    const r = mkExpr("math_arithmetic", node);
                    r.inputs = [
                        getValue("A", 0, numberType),
                        getValue("B", node, numberType)
                    ];
                    r.fields = [getField("OP", "MINUS")];
                    return r;
                }
                function getPrefixUnaryExpression(node) {
                    switch (node.operator) {
                        case SK.ExclamationToken:
                            const r = mkExpr("logic_negate", node);
                            r.inputs = [getConditionalInput("BOOL", node.operand)];
                            return r;
                        case SK.PlusToken:
                            return getOutputBlock(node.operand);
                        case SK.MinusToken:
                            if (node.operand.kind == SK.NumericLiteral) {
                                return getNumericLiteral("-" + node.operand.text);
                            }
                            else {
                                return negateNumericNode(node.operand);
                            }
                        default:
                            error(node);
                            break;
                    }
                    return undefined;
                }
                function getPropertyAccessExpression(n, asField = false, blockId) {
                    let callInfo = pxtc.pxtInfo(n).callInfo;
                    if (!callInfo) {
                        error(n);
                        return undefined;
                    }
                    if (n.expression.kind === SK.Identifier) {
                        const enumName = n.expression.text;
                        if (env.declaredEnums[enumName]) {
                            const enumInfo = blocksInfo.enumsByName[enumName];
                            if (enumInfo && enumInfo.blockId) {
                                return getFieldBlock(enumInfo.blockId, "MEMBER", n.name.text);
                            }
                        }
                        else if (env.declaredKinds[enumName]) {
                            const info = env.declaredKinds[enumName];
                            return getFieldBlock(info.kindInfo.blockId, "MEMBER", n.name.text);
                        }
                    }
                    const attributes = attrs(callInfo);
                    blockId = attributes.blockId || blockId;
                    if (attributes.blockCombine)
                        return getPropertyGetBlock(n, n);
                    if (attributes.blockId === "lists_length" || attributes.blockId === "text_length") {
                        const r = mkExpr(pxtc.U.htmlEscape(attributes.blockId), n);
                        r.inputs = [getValue("VALUE", n.expression)];
                        return r;
                    }
                    let value = pxtc.U.htmlEscape(attributes.blockId || callInfo.qName);
                    const [parent,] = getParent(n);
                    const parentCallInfo = parent && pxtc.pxtInfo(parent).callInfo;
                    if (asField || !(blockId || attributes.blockIdentity) || parentCallInfo && parentCallInfo.qName === attributes.blockIdentity) {
                        return {
                            kind: "text",
                            value
                        };
                    }
                    if (attributes.enumval && parentCallInfo && attributes.useEnumVal) {
                        value = attributes.enumval;
                    }
                    const info = env.compInfo(callInfo);
                    if (blockId && info && info.thisParameter) {
                        const r = mkExpr(blockId, n);
                        r.inputs = [getValue(pxtc.U.htmlEscape(info.thisParameter.definitionName), n.expression, info.thisParameter.shadowBlockId)];
                        return r;
                    }
                    let idfn = attributes.blockIdentity ? blocksInfo.apis.byQName[attributes.blockIdentity] : blocksInfo.blocksById[blockId];
                    return getEnumFieldBlock(idfn, value);
                }
                function getEnumFieldBlock(idfn, value) {
                    let f = /(?:%|\$)([a-zA-Z0-9_]+)/.exec(idfn.attributes.block);
                    const r = mkExpr(pxtc.U.htmlEscape(idfn.attributes.blockId), undefined);
                    r.fields = [{
                            kind: "field",
                            name: pxtc.U.htmlEscape(f[1]),
                            value
                        }];
                    return r;
                }
                function getArrayLiteralExpression(n) {
                    const r = mkExpr("lists_create_with", n);
                    r.inputs = n.elements.map((e, i) => getValue("ADD" + i, e));
                    r.mutation = {
                        "items": n.elements.length.toString()
                    };
                    return r;
                }
                function getElementAccessExpression(n) {
                    const r = mkExpr("lists_index_get", n);
                    r.inputs = [getValue("LIST", n.expression), getValue("INDEX", n.argumentExpression, numberType)];
                    return r;
                }
                function getTaggedTemplateExpression(t) {
                    const callInfo = pxtc.pxtInfo(t).callInfo;
                    let api;
                    const paramInfo = getParentParameterInfo(t);
                    if (paramInfo && paramInfo.shadowBlockId) {
                        const shadow = env.blocks.blocksById[paramInfo.shadowBlockId];
                        if (shadow && shadow.attributes.shim === "TD_ID") {
                            api = shadow;
                        }
                    }
                    if (!api) {
                        api = env.blocks.apis.byQName[attrs(callInfo).blockIdentity];
                    }
                    const comp = pxt.blocks.compileInfo(api);
                    const r = mkExpr(api.attributes.blockId, t);
                    let text;
                    const param = comp.parameters[0];
                    if (param.fieldOptions && param.fieldOptions[DecompileParamKeys.DecompileArgumentAsString]) {
                        text = t.getText();
                    }
                    else {
                        text = t.template.text;
                    }
                    // This will always be a field and not a value because we only allow no-substitution templates
                    r.fields = [getField(param.actualName, text)];
                    return r;
                }
                function getParentParameterInfo(n) {
                    if (n.parent && n.parent.kind === SK.CallExpression) {
                        const call = n.parent;
                        const info = pxtc.pxtInfo(call).callInfo;
                        const index = call.arguments.indexOf(n);
                        if (info && index !== -1) {
                            const blockInfo = blocksInfo.apis.byQName[info.qName];
                            if (blockInfo) {
                                const comp = pxt.blocks.compileInfo(blockInfo);
                                return comp && comp.parameters[index];
                            }
                        }
                    }
                    return undefined;
                }
                function getStatementBlock(n, next, parent, asExpression = false, topLevel = false) {
                    const node = n;
                    let stmt;
                    let skipComments = false;
                    const err = checkStatement(node, env, asExpression, topLevel);
                    if (err) {
                        stmt = getTypeScriptStatementBlock(node, undefined, err);
                    }
                    else {
                        switch (node.kind) {
                            case SK.Block:
                                let bBlock = codeBlock(node.statements, next, topLevel);
                                return bBlock;
                            case SK.ExpressionStatement:
                                return getStatementBlock(node.expression, next, parent || node, asExpression, topLevel);
                            case SK.VariableStatement:
                                stmt = codeBlock(node.declarationList.declarations, undefined, false, parent || node);
                                if (!stmt)
                                    return getNext();
                                // Comments are already gathered by the call to code block
                                skipComments = true;
                                break;
                            case SK.FunctionExpression:
                            case SK.ArrowFunction:
                                return getArrowFunctionStatement(node, next);
                            case SK.BinaryExpression:
                                stmt = getBinaryExpressionStatement(node);
                                break;
                            case SK.PostfixUnaryExpression:
                            case SK.PrefixUnaryExpression:
                                stmt = getIncrementStatement(node);
                                break;
                            case SK.VariableDeclaration:
                                const decl = node;
                                if (isAutoDeclaration(decl)) {
                                    // Don't emit null or automatic initializers;
                                    // They are implicit within the blocks. But do track them in case they
                                    // never get used in the blocks (and thus won't be emitted again)
                                    trackAutoDeclaration(decl);
                                    return getNext();
                                }
                                stmt = getVariableDeclarationStatement(node);
                                break;
                            case SK.WhileStatement:
                                stmt = getWhileStatement(node);
                                break;
                            case SK.IfStatement:
                                stmt = getIfStatement(node);
                                break;
                            case SK.ForStatement:
                                stmt = getForStatement(node);
                                break;
                            case SK.ForOfStatement:
                                stmt = getForOfStatement(node);
                                break;
                            case SK.FunctionDeclaration:
                                stmt = getFunctionDeclaration(node);
                                break;
                            case SK.CallExpression:
                                stmt = getCallStatement(node, asExpression);
                                break;
                            case SK.DebuggerStatement:
                                stmt = getDebuggerStatementBlock(node);
                                break;
                            case SK.BreakStatement:
                                stmt = getBreakStatementBlock(node);
                                break;
                            case SK.ContinueStatement:
                                stmt = getContinueStatementBlock(node);
                                break;
                            case SK.EmptyStatement:
                                stmt = undefined; // don't generate blocks for empty statements
                                break;
                            case SK.EnumDeclaration:
                            case SK.ModuleDeclaration:
                                // If the enum declaration made it past the checker then it is emitted elsewhere
                                markCommentsInRange(node, commentMap);
                                return getNext();
                            case SK.ReturnStatement:
                                stmt = getReturnStatementBlock(node);
                                break;
                            default:
                                if (next) {
                                    error(node, pxtc.Util.lf("Unsupported statement in block: {0}", SK[node.kind]));
                                }
                                else {
                                    error(node, pxtc.Util.lf("Statement kind unsupported in blocks: {0}", SK[node.kind]));
                                }
                                return undefined;
                        }
                    }
                    if (stmt) {
                        let end = stmt;
                        while (end.next) {
                            end = end.next;
                        }
                        end.next = getNext();
                        if (end.next) {
                            end.next.prev = end;
                        }
                    }
                    if (!skipComments) {
                        getComments(parent || node);
                    }
                    return stmt;
                    function getNext() {
                        if (next && next.length) {
                            return getStatementBlock(next.shift(), next, undefined, false, topLevel);
                        }
                        return undefined;
                    }
                    /**
                     * We split up comments according to the following rules:
                     *      1. If the comment is not top-level:
                     *          a. Combine it with all comments for the following statement
                     *          b. If there is no following statement in the current block, group it with the previous statement
                     *          c. If there are no statements inside the block, group it with the parent block
                     *          d. If trailing the same line as the statement, group it with the comments for that statement
                     *      2. If the comment is top-level:
                     *          b. If the comment is followed by an empty line, it becomes a workspace comment
                     *          c. If the comment is followed by a multi-line comment, it becomes a workspace comment
                     *          a. If the comment is a single-line comment, combine it with the next single-line comment
                     *          d. If the comment is not followed with an empty line, group it with the next statement or event
                     *          e. All other comments are workspace comments
                     */
                    function getComments(commented) {
                        let comments = [];
                        let current;
                        for (let i = 0; i < commentMap.length; i++) {
                            current = commentMap[i];
                            if (!current.owner && current.start >= commented.pos && current.end <= commented.end) {
                                current.owner = commented;
                                current.ownerStatement = stmt;
                                comments.push(current);
                            }
                            if (current.start > commented.end)
                                break;
                        }
                        if (current && current.isTrailingComment) {
                            const endLine = ts.getLineAndCharacterOfPosition(file, commented.end);
                            const commentLine = ts.getLineAndCharacterOfPosition(file, current.start);
                            if (endLine.line === commentLine.line) {
                                // If the comment is trailing and on the same line as the statement, it probably belongs
                                // to this statement. Remove it from any statement it's already assigned to and any workspace
                                // comments
                                if (current.ownerStatement) {
                                    current.ownerStatement.comment.splice(current.ownerStatement.comment.indexOf(current), 1);
                                    for (const wsComment of workspaceComments) {
                                        wsComment.comment.splice(wsComment.comment.indexOf(current), 1);
                                    }
                                }
                                current.owner = commented;
                                current.ownerStatement = stmt;
                                comments.push(current);
                            }
                        }
                        if (comments.length) {
                            const wsCommentRefs = [];
                            if (isTopLevelComment(commented)) {
                                let currentWorkspaceComment = [];
                                const localWorkspaceComments = [];
                                comments.forEach((comment, index) => {
                                    let beforeStatement = comment.owner && comment.start < comment.owner.getStart();
                                    if (comment.kind === CommentKind.MultiLine && beforeStatement) {
                                        if (currentWorkspaceComment.length) {
                                            localWorkspaceComments.push(currentWorkspaceComment);
                                            currentWorkspaceComment = [];
                                        }
                                        if (index != comments.length - 1) {
                                            localWorkspaceComments.push([comment]);
                                            return;
                                        }
                                    }
                                    currentWorkspaceComment.push(comment);
                                    if (comment.followedByEmptyLine && beforeStatement) {
                                        localWorkspaceComments.push(currentWorkspaceComment);
                                        currentWorkspaceComment = [];
                                    }
                                });
                                comments = currentWorkspaceComment;
                                localWorkspaceComments.forEach(comment => {
                                    const refId = getCommentRef();
                                    wsCommentRefs.push(refId);
                                    workspaceComments.push({ comment, refId });
                                });
                            }
                            if (stmt) {
                                if (wsCommentRefs.length) {
                                    if (stmt.data)
                                        stmt.data += ";" + wsCommentRefs.join(";");
                                    else
                                        stmt.data = wsCommentRefs.join(";");
                                }
                                if (comments && comments.length) {
                                    if (stmt.comment)
                                        stmt.comment = stmt.comment.concat(comments);
                                    else
                                        stmt.comment = comments;
                                }
                            }
                        }
                    }
                }
                function getTypeScriptStatementBlock(node, prefix, err) {
                    if (options.errorOnGreyBlocks)
                        error(node);
                    const r = mkStmt(pxtc.TS_STATEMENT_TYPE, node);
                    r.mutation = {};
                    trackVariableUsagesInText(node);
                    let text = node.getText();
                    const start = node.getStart();
                    const end = node.getEnd();
                    text = applyRenamesInRange(text, start, end);
                    // Mark comments or else they are emitted twice
                    markCommentsInRange(node, commentMap);
                    if (prefix) {
                        text = prefix + text;
                    }
                    const declaredVariables = [];
                    if (node.kind === SK.VariableStatement) {
                        for (const declaration of node.declarationList.declarations) {
                            declaredVariables.push(getVariableName(declaration.name));
                        }
                    }
                    else if (node.kind === SK.VariableDeclaration) {
                        declaredVariables.push(getVariableName(node.name));
                    }
                    if (declaredVariables.length) {
                        r.mutation["declaredvars"] = declaredVariables.join(",");
                    }
                    const parts = text.split("\n");
                    r.mutation["numlines"] = parts.length.toString();
                    if (err && options.includeGreyBlockMessages) {
                        r.mutation["error"] = pxtc.U.htmlEscape(err);
                    }
                    parts.forEach((p, i) => {
                        r.mutation[`line${i}`] = pxtc.U.htmlEscape(p);
                    });
                    return r;
                }
                function getContinueStatementBlock(node) {
                    const r = mkStmt(pxtc.TS_CONTINUE_TYPE, node);
                    return r;
                }
                function getBreakStatementBlock(node) {
                    const r = mkStmt(pxtc.TS_BREAK_TYPE, node);
                    return r;
                }
                function getDebuggerStatementBlock(node) {
                    const r = mkStmt(pxtc.TS_DEBUGGER_TYPE, node);
                    return r;
                }
                function getReturnStatementBlock(node) {
                    const r = mkStmt(pxtc.TS_RETURN_STATEMENT_TYPE, node);
                    if (node.expression) {
                        r.inputs = [
                            mkValue("RETURN_VALUE", getOutputBlock(node.expression), numberType)
                        ];
                    }
                    else {
                        r.mutation = {
                            "no_return_value": "true"
                        };
                    }
                    return r;
                }
                function getImageLiteralStatement(node, info) {
                    let arg = node.arguments[0];
                    if (arg.kind != SK.StringLiteral && arg.kind != SK.NoSubstitutionTemplateLiteral) {
                        error(node);
                        return undefined;
                    }
                    const attributes = attrs(info);
                    const res = mkStmt(attributes.blockId, node);
                    res.fields = [];
                    const leds = (arg.text || '').replace(/\s+/g, '');
                    const nc = (attributes.imageLiteralColumns || 5) * attributes.imageLiteral;
                    const nr = attributes.imageLiteralRows || 5;
                    const nleds = nc * nr;
                    if (nleds != leds.length) {
                        error(node, pxtc.Util.lf("Invalid image pattern ({0} expected vs {1} actual)", nleds, leds.length));
                        return undefined;
                    }
                    let ledString = '';
                    for (let r = 0; r < nr; ++r) {
                        for (let c = 0; c < nc; ++c) {
                            ledString += /[#*1]/.test(leds[r * nc + c]) ? '#' : '.';
                        }
                        ledString += '\n';
                    }
                    res.fields.push(getField(`LEDS`, `\`${ledString}\``));
                    return res;
                }
                function getBinaryExpressionStatement(n) {
                    const name = n.left.text;
                    switch (n.operatorToken.kind) {
                        case SK.EqualsToken:
                            if (n.left.kind === SK.Identifier) {
                                return getVariableSetOrChangeBlock(n, n.left, n.right);
                            }
                            else if (n.left.kind == SK.PropertyAccessExpression) {
                                return getPropertySetBlock(n, n.left, n.right, "@set@");
                            }
                            else {
                                return getArraySetBlock(n, n.left, n.right);
                            }
                        case SK.PlusEqualsToken:
                            if (isTextJoin(n)) {
                                const r = mkStmt("variables_set", n);
                                const renamed = getVariableName(n.left);
                                trackVariableUsage(renamed, ReferenceType.InBlocksOnly);
                                r.inputs = [mkValue("VALUE", getTextJoin(n), numberType)];
                                r.fields = [getField("VAR", renamed)];
                                return r;
                            }
                            if (n.left.kind == SK.PropertyAccessExpression)
                                return getPropertySetBlock(n, n.left, n.right, "@change@");
                            else
                                return getVariableSetOrChangeBlock(n, n.left, n.right, true);
                        case SK.MinusEqualsToken:
                            const r = mkStmt("variables_change", n);
                            r.inputs = [mkValue("VALUE", negateNumericNode(n.right), numberType)];
                            r.fields = [getField("VAR", getVariableName(n.left))];
                            return r;
                        default:
                            error(n, pxtc.Util.lf("Unsupported operator token in statement {0}", SK[n.operatorToken.kind]));
                            return undefined;
                    }
                }
                function getWhileStatement(n) {
                    const r = mkStmt("device_while", n);
                    r.inputs = [getConditionalInput("COND", n.expression)];
                    r.handlers = [{ name: "DO", statement: getStatementBlock(n.statement) }];
                    return r;
                }
                function getIfStatement(n) {
                    let flatif = flattenIfStatement(n);
                    const r = mkStmt("controls_if", n);
                    r.mutation = {
                        "elseif": (flatif.ifStatements.length - 1).toString(),
                        "else": flatif.elseStatement ? "1" : "0"
                    };
                    r.inputs = [];
                    r.handlers = [];
                    flatif.ifStatements.forEach((stmt, i) => {
                        let statement = getStatementBlock(stmt.thenStatement);
                        r.inputs.push(getConditionalInput("IF" + i, stmt.expression));
                        r.handlers.push({ name: "DO" + i, statement });
                    });
                    if (flatif.elseStatement) {
                        let statement = getStatementBlock(flatif.elseStatement);
                        r.handlers.push({ name: "ELSE", statement });
                    }
                    return r;
                }
                function getConditionalInput(name, expr) {
                    const err = checkConditionalExpression(expr);
                    if (err) {
                        const tsExpr = getTypeScriptExpressionBlock(expr);
                        return mkValue(name, tsExpr, booleanType);
                    }
                    else {
                        return getValue(name, expr, booleanType);
                    }
                }
                function checkConditionalExpression(expr) {
                    const unwrappedExpr = unwrapNode(expr);
                    switch (unwrappedExpr.kind) {
                        case SK.TrueKeyword:
                        case SK.FalseKeyword:
                        case SK.Identifier:
                        case SK.ElementAccessExpression:
                            return undefined;
                        case SK.BinaryExpression:
                            return checkBooleanBinaryExpression(unwrappedExpr);
                        case SK.CallExpression:
                            return checkBooleanCallExpression(unwrappedExpr);
                        case SK.PrefixUnaryExpression:
                            if (unwrappedExpr.operator === SK.ExclamationToken) {
                                return undefined;
                            } // else fall through
                        default:
                            return pxtc.Util.lf("Conditions must evaluate to booleans or identifiers");
                    }
                    function checkBooleanBinaryExpression(n) {
                        switch (n.operatorToken.kind) {
                            case SK.EqualsEqualsToken:
                            case SK.EqualsEqualsEqualsToken:
                            case SK.ExclamationEqualsToken:
                            case SK.ExclamationEqualsEqualsToken:
                            case SK.LessThanToken:
                            case SK.LessThanEqualsToken:
                            case SK.GreaterThanToken:
                            case SK.GreaterThanEqualsToken:
                            case SK.AmpersandAmpersandToken:
                            case SK.BarBarToken:
                                return undefined;
                            default:
                                return pxtc.Util.lf("Binary expressions in conditionals must evaluate to booleans");
                        }
                    }
                    function checkBooleanCallExpression(n) {
                        const callInfo = pxtc.pxtInfo(n).callInfo;
                        if (callInfo) {
                            const api = env.blocks.apis.byQName[callInfo.qName];
                            if (api && api.retType == "boolean") {
                                return undefined;
                            }
                            else if (ts.isIdentifier(n.expression) && env.declaredFunctions[n.expression.text]) {
                                // User functions have a return type of "any" in blocks so they are safe to decompile
                                return undefined;
                            }
                        }
                        return pxtc.Util.lf("Only functions that return booleans are allowed as conditions");
                    }
                }
                function getForStatement(n) {
                    const initializer = n.initializer;
                    const indexVar = initializer.declarations[0].name.text;
                    const condition = n.condition;
                    const renamed = getVariableName(initializer.declarations[0].name);
                    let r;
                    if (condition.operatorToken.kind === SK.LessThanToken && !checkForVariableUsages(n.statement)) {
                        r = mkStmt("controls_repeat_ext", n);
                        r.fields = [];
                        r.inputs = [getValue("TIMES", condition.right, wholeNumberType)];
                        r.handlers = [];
                    }
                    else {
                        r = mkStmt("pxt_controls_for", n);
                        r.fields = [];
                        r.inputs = [];
                        r.handlers = [];
                        r.inputs = [getDraggableVariableBlock("VAR", renamed)];
                        if (condition.operatorToken.kind === SK.LessThanToken) {
                            const unwrappedRightSide = unwrapNode(condition.right);
                            if (unwrappedRightSide.kind === SK.NumericLiteral) {
                                const decrementedValue = parseFloat(unwrappedRightSide.text) - 1;
                                const valueField = getNumericLiteral(decrementedValue + "");
                                r.inputs.push(mkValue("TO", valueField, wholeNumberType));
                            }
                            else {
                                const ex = mkExpr("math_arithmetic", n);
                                ex.fields = [getField("OP", "MINUS")];
                                ex.inputs = [
                                    getValue("A", unwrappedRightSide, numberType),
                                    getValue("B", 1, numberType)
                                ];
                                r.inputs.push(mkValue("TO", ex, wholeNumberType));
                            }
                        }
                        else if (condition.operatorToken.kind === SK.LessThanEqualsToken) {
                            r.inputs.push(getValue("TO", condition.right, wholeNumberType));
                        }
                    }
                    const statement = getStatementBlock(n.statement);
                    r.handlers = [{ name: "DO", statement }];
                    return r;
                    function checkForVariableUsages(node) {
                        if (node.kind === SK.Identifier && getVariableName(node) === renamed) {
                            return true;
                        }
                        return ts.forEachChild(node, checkForVariableUsages);
                    }
                }
                function getForOfStatement(n) {
                    const initializer = n.initializer;
                    const renamed = getVariableName(initializer.declarations[0].name);
                    const r = mkStmt("pxt_controls_for_of", n);
                    r.inputs = [getValue("LIST", n.expression), getDraggableVariableBlock("VAR", renamed)];
                    const statement = getStatementBlock(n.statement);
                    r.handlers = [{ name: "DO", statement }];
                    return r;
                }
                function getVariableSetOrChangeBlock(n, name, value, changed = false, overrideName = false) {
                    const renamed = getVariableName(name);
                    trackVariableUsage(renamed, ReferenceType.InBlocksOnly);
                    // We always do a number shadow even if the variable is not of type number
                    const r = mkStmt(changed ? "variables_change" : "variables_set", n.parent || n);
                    r.inputs = [getValue("VALUE", value, numberType)];
                    r.fields = [getField("VAR", renamed)];
                    return r;
                }
                function getArraySetBlock(n, left, right) {
                    const r = mkStmt("lists_index_set", n);
                    r.inputs = [
                        getValue("LIST", left.expression),
                        getValue("INDEX", left.argumentExpression, numberType),
                        getValue("VALUE", right)
                    ];
                    return r;
                }
                function getPropertySetBlock(n, left, right, tp) {
                    return getPropertyBlock(n, left, right, tp);
                }
                function getPropertyGetBlock(n, left) {
                    return getPropertyBlock(n, left, null, "@get@");
                }
                function getPropertyBlock(n, left, right, tp) {
                    const info = pxtc.pxtInfo(left).callInfo;
                    const sym = env.blocks.apis.byQName[info ? info.qName : ""];
                    if (!sym || !sym.attributes.blockCombine) {
                        error(left);
                        return undefined;
                    }
                    const qName = `${sym.namespace}.${sym.retType}.${tp}`;
                    const setter = env.blocks.blocks.find(b => b.qName == qName);
                    const r = right ? mkStmt(setter.attributes.blockId, n) : mkExpr(setter.attributes.blockId, n);
                    const pp = setter.attributes._def.parameters;
                    let fieldValue = info.qName;
                    if (setter.combinedProperties) {
                        // getters/setters have annotations at the end of their names so look them up
                        setter.combinedProperties.forEach(pName => {
                            if (pName.indexOf(info.qName) === 0 && pName.charAt(info.qName.length) === "@") {
                                fieldValue = pName;
                            }
                        });
                    }
                    r.inputs = [getValue(pp[0].name, left.expression)];
                    r.fields = [getField(pp[1].name, fieldValue)];
                    if (right)
                        r.inputs.push(getValue(pp[2].name, right));
                    return r;
                }
                function getVariableDeclarationStatement(n) {
                    if (addVariableDeclaration(n)) {
                        return getVariableSetOrChangeBlock(n, n.name, n.initializer);
                    }
                    return undefined;
                }
                function getIncrementStatement(node) {
                    const isPlusPlus = node.operator === SK.PlusPlusToken;
                    if (!isPlusPlus && node.operator !== SK.MinusMinusToken) {
                        error(node);
                        return undefined;
                    }
                    return getVariableSetOrChangeBlock(node, node.operand, isPlusPlus ? 1 : -1, true);
                }
                function getFunctionDeclaration(n) {
                    const name = getVariableName(n.name);
                    env.localReporters.push(n.parameters.map(p => {
                        return {
                            name: p.name.getText(),
                            type: p.type.getText()
                        };
                    }));
                    const statements = getStatementBlock(n.body);
                    env.localReporters.pop();
                    let r;
                    r = mkStmt("function_definition", n);
                    r.mutation = {
                        name
                    };
                    if (n.parameters) {
                        r.mutationChildren = [];
                        n.parameters.forEach(p => {
                            const paramName = p.name.getText();
                            let type = normalizeType(p.type.getText());
                            if (pxt.U.endsWith(type, "[]"))
                                type = "Array";
                            r.mutationChildren.push({
                                nodeName: "arg",
                                attributes: {
                                    name: paramName,
                                    type,
                                    id: env.functionParamIds[name][paramName]
                                }
                            });
                        });
                    }
                    r.handlers = [{ name: "STACK", statement: statements }];
                    return r;
                }
                function getCallStatement(node, asExpression) {
                    const info = pxtc.pxtInfo(node).callInfo;
                    const attributes = attrs(info);
                    if (info.qName == "Math.pow") {
                        const r = mkExpr("math_arithmetic", node);
                        r.inputs = [
                            mkValue("A", getOutputBlock(node.arguments[0]), numberType),
                            mkValue("B", getOutputBlock(node.arguments[1]), numberType)
                        ];
                        r.fields = [getField("OP", "POWER")];
                        return r;
                    }
                    else if (pxt.Util.startsWith(info.qName, "Math.")) {
                        const op = info.qName.substring(5);
                        if (isSupportedMathFunction(op)) {
                            let r;
                            if (isRoundingFunction(op)) {
                                r = mkExpr("math_js_round", node);
                            }
                            else {
                                r = mkExpr("math_js_op", node);
                                let opType;
                                if (isUnaryMathFunction(op))
                                    opType = "unary";
                                else if (isInfixMathFunction(op))
                                    opType = "infix";
                                else
                                    opType = "binary";
                                r.mutation = { "op-type": opType };
                            }
                            r.inputs = info.args.map((arg, index) => mkValue("ARG" + index, getOutputBlock(arg), "math_number"));
                            r.fields = [getField("OP", op)];
                            return r;
                        }
                    }
                    if (attributes.blockId === pxtc.PAUSE_UNTIL_TYPE) {
                        const r = mkStmt(pxtc.PAUSE_UNTIL_TYPE, node);
                        const lambda = node.arguments[0];
                        let condition;
                        if (lambda.body.kind === SK.Block) {
                            // We already checked to make sure the body is a single return statement
                            condition = lambda.body.statements[0].expression;
                        }
                        else {
                            condition = lambda.body;
                        }
                        r.inputs = [mkValue("PREDICATE", getOutputBlock(condition), "logic_boolean")];
                        return r;
                    }
                    if (!attributes.blockId || !attributes.block) {
                        const builtin = pxt.blocks.builtinFunctionInfo[info.qName];
                        if (!builtin) {
                            const name = getVariableName(node.expression);
                            if (env.declaredFunctions[name]) {
                                let r;
                                let isStatement = true;
                                if (info.isExpression) {
                                    const [parent] = getParent(node);
                                    isStatement = parent && parent.kind === SK.ExpressionStatement;
                                }
                                r = mkStmt(isStatement ? "function_call" : "function_call_output", node);
                                if (info.args.length) {
                                    r.mutationChildren = [];
                                    r.inputs = [];
                                    env.declaredFunctions[name].parameters.forEach((p, i) => {
                                        const paramName = p.name.getText();
                                        const argId = env.functionParamIds[name][paramName];
                                        let type = normalizeType(p.type.getText());
                                        if (pxt.U.endsWith(type, "[]"))
                                            type = "Array";
                                        r.mutationChildren.push({
                                            nodeName: "arg",
                                            attributes: {
                                                name: paramName,
                                                type: type,
                                                id: argId
                                            }
                                        });
                                        const argBlock = getOutputBlock(info.args[i]);
                                        const value = mkValue(argId, argBlock);
                                        r.inputs.push(value);
                                    });
                                }
                                r.mutation = { name };
                                return r;
                            }
                            else {
                                return getTypeScriptStatementBlock(node);
                            }
                        }
                        attributes.blockId = builtin.blockId;
                    }
                    if (attributes.imageLiteral) {
                        return getImageLiteralStatement(node, info);
                    }
                    if (ts.isFunctionLike(info.decl)) {
                        // const decl = info.decl as FunctionLikeDeclaration;
                        // if (decl.parameters && decl.parameters.length === 1 && ts.isRestParameter(decl.parameters[0])) {
                        //     openCallExpressionBlockWithRestParameter(node, info);
                        //     return;
                        // }
                    }
                    const args = paramList(info, env.blocks);
                    const api = env.blocks.apis.byQName[info.decompilerBlockAlias || info.qName];
                    const comp = pxt.blocks.compileInfo(api);
                    const r = asExpression ? mkExpr(attributes.blockId, node)
                        : mkStmt(attributes.blockId, node);
                    const addInput = (v) => (r.inputs || (r.inputs = [])).push(v);
                    const addField = (f) => (r.fields || (r.fields = [])).push(f);
                    if (info.qName == "Math.max") {
                        addField({
                            kind: "field",
                            name: "op",
                            value: "max"
                        });
                    }
                    let optionalCount = 0;
                    args.forEach((arg, i) => {
                        let e = arg.value;
                        let shadowMutation;
                        const param = arg.param;
                        const paramInfo = arg.info;
                        const paramComp = comp.parameters[comp.thisParameter ? i - 1 : i];
                        const paramRange = paramComp && paramComp.range;
                        if (paramRange) {
                            const min = paramRange['min'];
                            const max = paramRange['max'];
                            shadowMutation = { 'min': min.toString(), 'max': max.toString() };
                        }
                        if (i === 0 && attributes.defaultInstance) {
                            if (e.getText() === attributes.defaultInstance) {
                                return;
                            }
                            else {
                                r.mutation = { "showing": "true" };
                            }
                        }
                        if (attributes.mutatePropertyEnum && i === info.args.length - 2) {
                            // Implicit in the blocks
                            return;
                        }
                        if (param && param.isOptional) {
                            ++optionalCount;
                        }
                        let shadowBlockInfo;
                        if (param && param.shadowBlockId) {
                            shadowBlockInfo = blocksInfo.blocksById[param.shadowBlockId];
                        }
                        if (e.kind === SK.CallExpression) {
                            // Many enums have shim wrappers that need to be unwrapped if used
                            // in a parameter that is of an enum type. By default, enum parameters
                            // are dropdown fields (not value inputs) so we want to decompile the
                            // inner enum value as a field and not the shim block as a value
                            const shimCall = pxtc.pxtInfo(e).callInfo;
                            const shimAttrs = shimCall && attrs(shimCall);
                            if (shimAttrs && shimAttrs.shim === "TD_ID" && paramInfo.isEnum) {
                                e = unwrapNode(shimCall.args[0]);
                            }
                        }
                        if (param && paramInfo && paramInfo.isEnum && e.kind === SK.Identifier) {
                            addField(getField(pxtc.U.htmlEscape(param.definitionName), pxtc.pxtInfo(e).commentAttrs.enumIdentity));
                            return;
                        }
                        if (param && param.fieldOptions && param.fieldOptions[DecompileParamKeys.DecompileArgumentAsString]) {
                            addField(getField(pxtc.U.htmlEscape(param.definitionName), pxtc.Util.htmlEscape(e.getText())));
                            return;
                        }
                        switch (e.kind) {
                            case SK.FunctionExpression:
                            case SK.ArrowFunction:
                                const m = getDestructuringMutation(e);
                                let mustPopLocalScope = false;
                                if (m) {
                                    r.mutation = m;
                                }
                                else {
                                    let arrow = e;
                                    const sym = blocksInfo.blocksById[attributes.blockId];
                                    const paramDesc = sym.parameters[comp.thisParameter ? i - 1 : i];
                                    const addDraggableInput = (arg, varName) => {
                                        if (attributes.draggableParameters === "reporter") {
                                            addInput(mkDraggableReporterValue("HANDLER_DRAG_PARAM_" + arg.name, varName, arg.type));
                                        }
                                        else {
                                            addInput(getDraggableVariableBlock("HANDLER_DRAG_PARAM_" + arg.name, varName));
                                        }
                                    };
                                    if (arrow.parameters.length) {
                                        if (attributes.optionalVariableArgs) {
                                            r.mutation = {
                                                "numargs": arrow.parameters.length.toString()
                                            };
                                            arrow.parameters.forEach((parameter, i) => {
                                                r.mutation["arg" + i] = parameter.name.text;
                                            });
                                        }
                                        else {
                                            arrow.parameters.forEach((parameter, i) => {
                                                const arg = paramDesc.handlerParameters[i];
                                                if (attributes.draggableParameters) {
                                                    addDraggableInput(arg, parameter.name.text);
                                                }
                                                else {
                                                    addField(getField("HANDLER_" + arg.name, parameter.name.text));
                                                }
                                            });
                                        }
                                    }
                                    if (attributes.draggableParameters) {
                                        if (arrow.parameters.length < paramDesc.handlerParameters.length) {
                                            for (let i = arrow.parameters.length; i < paramDesc.handlerParameters.length; i++) {
                                                const arg = paramDesc.handlerParameters[i];
                                                addDraggableInput(arg, arg.name);
                                            }
                                        }
                                        if (attributes.draggableParameters === "reporter") {
                                            // Push the parameter descriptions onto the local scope stack
                                            // so the getStatementBlock() below knows that these parameters
                                            // should be decompiled as reporters instead of variables.
                                            env.localReporters.push(paramDesc.handlerParameters);
                                            mustPopLocalScope = true;
                                        }
                                    }
                                }
                                const statement = getStatementBlock(e);
                                (r.handlers || (r.handlers = [])).push({ name: "HANDLER", statement });
                                if (mustPopLocalScope) {
                                    env.localReporters.pop();
                                }
                                break;
                            case SK.PropertyAccessExpression:
                                const callInfo = pxtc.pxtInfo(e).callInfo;
                                const aName = pxtc.U.htmlEscape(param.definitionName);
                                const argAttrs = attrs(callInfo);
                                if (shadowBlockInfo && shadowBlockInfo.attributes.shim === "TD_ID") {
                                    addInput(mkValue(aName, getPropertyAccessExpression(e, false, param.shadowBlockId), param.shadowBlockId, shadowMutation));
                                }
                                else if (paramInfo && paramInfo.isEnum || callInfo && (argAttrs.fixedInstance || argAttrs.blockIdentity === info.qName)) {
                                    addField(getField(aName, getPropertyAccessExpression(e, true).value));
                                }
                                else {
                                    addInput(getValue(aName, e, param.shadowBlockId, shadowMutation));
                                }
                                break;
                            case SK.BinaryExpression:
                                if (param && param.shadowOptions && param.shadowOptions.toString) {
                                    const be = e;
                                    if (be.operatorToken.kind === SK.PlusToken && isEmptyStringNode(be.left)) {
                                        addInput(getValue(pxtc.U.htmlEscape(param.definitionName), be.right, param.shadowBlockId || "text"));
                                        break;
                                    }
                                }
                                addInput(getValue(pxtc.U.htmlEscape(param.definitionName), e, param.shadowBlockId, shadowMutation));
                                break;
                            default:
                                let v;
                                const vName = pxtc.U.htmlEscape(param.definitionName);
                                let defaultV = true;
                                if (info.qName == "Math.random") {
                                    v = mkValue(vName, getMathRandomArgumentExpresion(e), numberType, shadowMutation);
                                    defaultV = false;
                                }
                                else if (isLiteralNode(e)) {
                                    // Remove quotes on strings
                                    const fieldText = param.fieldEditor == 'text' ? e.text : e.getText();
                                    const isFieldBlock = param.shadowBlockId && !isLiteralBlockType(param.shadowBlockId);
                                    if (decompileLiterals(param) && param.fieldOptions['onParentBlock']) {
                                        addField(getField(vName, fieldText));
                                        return;
                                    }
                                    else if (isFieldBlock) {
                                        const field = fieldBlockInfo(param.shadowBlockId);
                                        if (field && decompileLiterals(field)) {
                                            const fieldBlock = getFieldBlock(param.shadowBlockId, field.definitionName, fieldText, true);
                                            if (param.shadowOptions) {
                                                fieldBlock.mutation = { "customfield": pxtc.Util.htmlEscape(JSON.stringify(param.shadowOptions)) };
                                            }
                                            v = mkValue(vName, fieldBlock, param.shadowBlockId, shadowMutation);
                                            defaultV = false;
                                        }
                                    }
                                }
                                else if (e.kind === SK.TaggedTemplateExpression && param.fieldOptions && param.fieldOptions[DecompileParamKeys.TaggedTemplate]) {
                                    addField(getField(vName, pxtc.Util.htmlEscape(e.getText())));
                                    return;
                                }
                                if (defaultV) {
                                    v = getValue(vName, e, param.shadowBlockId, shadowMutation);
                                }
                                addInput(v);
                                break;
                        }
                    });
                    if (optionalCount) {
                        if (!r.mutation)
                            r.mutation = {};
                        if (attributes.compileHiddenArguments) {
                            // Only expand the optional arguments that do not map to shadow blocks
                            let nonOptional = 0;
                            let expandCount = 0;
                            for (const arg of args) {
                                const aName = pxtc.U.htmlEscape(arg.param.definitionName);
                                const input = r.inputs.find(i => i.name === aName);
                                if (!arg.param.isOptional) {
                                    nonOptional++;
                                }
                                else if (input && !shouldEmitShadowOnly(input)) {
                                    expandCount = Math.max(arg.param.definitionIndex - nonOptional + 1, expandCount);
                                }
                            }
                            r.mutation["_expanded"] = expandCount.toString();
                        }
                        else {
                            r.mutation["_expanded"] = optionalCount.toString();
                        }
                    }
                    return r;
                }
                function fieldBlockInfo(blockId) {
                    if (blocksInfo.blocksById[blockId]) {
                        const comp = pxt.blocks.compileInfo(blocksInfo.blocksById[blockId]);
                        if (!comp.thisParameter && comp.parameters.length === 1) {
                            return comp.parameters[0];
                        }
                    }
                    return undefined;
                }
                function decompileLiterals(param) {
                    return param && param.fieldOptions && param.fieldOptions[DecompileParamKeys.DecompileLiterals];
                }
                // function openCallExpressionBlockWithRestParameter(call: ts.CallExpression, info: pxtc.CallInfo) {
                //     openBlockTag(info.attrs.blockId);
                //     write(`<mutation count="${info.args.length}" />`)
                //     info.args.forEach((expression, index) => {
                //         emitValue("value_input_" + index, expression, numberType);
                //     });
                // }
                function getDestructuringMutation(callback) {
                    const bindings = getObjectBindingProperties(callback);
                    if (bindings) {
                        return {
                            "callbackproperties": bindings[0].join(","),
                            "renamemap": pxtc.Util.htmlEscape(JSON.stringify(bindings[1]))
                        };
                    }
                    return undefined;
                }
                function getMathRandomArgumentExpresion(e) {
                    switch (e.kind) {
                        case SK.NumericLiteral:
                            const n = e;
                            return getNumericLiteral((parseInt(n.text) - 1).toString());
                        case SK.BinaryExpression:
                            const op = e;
                            if (op.operatorToken.kind == SK.PlusToken && op.right.text == "1") {
                                return getOutputBlock(op.left);
                            }
                        default:
                            //This will definitely lead to an error, but the above are the only two cases generated by blocks
                            return getOutputBlock(e);
                    }
                }
                function getArrowFunctionStatement(n, next) {
                    return getStatementBlock(n.body, next);
                }
                function flattenIfStatement(n) {
                    let r = {
                        ifStatements: [{
                                expression: n.expression,
                                thenStatement: n.thenStatement
                            }],
                        elseStatement: n.elseStatement
                    };
                    if (n.elseStatement && n.elseStatement.kind == SK.IfStatement) {
                        let flat = flattenIfStatement(n.elseStatement);
                        r.ifStatements = r.ifStatements.concat(flat.ifStatements);
                        r.elseStatement = flat.elseStatement;
                    }
                    return r;
                }
                function codeBlock(statements, next, topLevel = false, parent, emitOnStart = false) {
                    const eventStatements = [];
                    const blockStatements = next || [];
                    // Go over the statements in reverse so that we can insert the nodes into the existing list if there is one
                    for (let i = statements.length - 1; i >= 0; i--) {
                        const statement = statements[i];
                        if ((statement.kind === SK.FunctionDeclaration ||
                            (statement.kind == SK.ExpressionStatement && isEventExpression(statement))) &&
                            !checkStatement(statement, env, false, topLevel)) {
                            eventStatements.unshift(statement);
                        }
                        else {
                            blockStatements.unshift(statement);
                        }
                    }
                    eventStatements.map(n => getStatementBlock(n, undefined, undefined, false, topLevel)).forEach(emitStatementNode);
                    if (blockStatements.length) {
                        // wrap statement in "on start" if top level
                        const stmtNode = blockStatements.shift();
                        const stmt = getStatementBlock(stmtNode, blockStatements, parent, false, topLevel);
                        if (emitOnStart) {
                            // Preserve any variable edeclarations that were never used
                            let current = stmt;
                            let currentNode = stmtNode;
                            autoDeclarations.forEach(([name, node]) => {
                                if (varUsages[name] === ReferenceType.InBlocksOnly) {
                                    return;
                                }
                                let e = node.initializer;
                                let v;
                                if (varUsages[name] === ReferenceType.InTextBlocks) {
                                    // If a variable is referenced inside a "grey" block, we need
                                    // to be conservative because our type inference might not work
                                    // on the round trip
                                    v = getTypeScriptStatementBlock(node, "let ");
                                }
                                else {
                                    v = getVariableSetOrChangeBlock(stmtNode, node.name, node.initializer, false, true);
                                }
                                v.next = current;
                                current = v;
                                currentNode = node;
                            });
                            if (current) {
                                const r = mkStmt(ts.pxtc.ON_START_TYPE, currentNode);
                                r.handlers = [{
                                        name: "HANDLER",
                                        statement: current
                                    }];
                                return r;
                            }
                            else {
                                maybeEmitEmptyOnStart(stmt);
                            }
                        }
                        return stmt;
                    }
                    else if (emitOnStart) {
                        maybeEmitEmptyOnStart(undefined);
                    }
                    return undefined;
                }
                function maybeEmitEmptyOnStart(node) {
                    if (options.alwaysEmitOnStart) {
                        openBlockTag(ts.pxtc.ON_START_TYPE, node);
                        closeBlockTag();
                    }
                }
                function trackVariableUsage(name, type) {
                    if (varUsages[name] !== ReferenceType.InTextBlocks) {
                        varUsages[name] = type;
                    }
                }
                function trackVariableUsagesInText(node) {
                    ts.forEachChild(node, (n) => {
                        if (n.kind === SK.Identifier) {
                            trackVariableUsage(getVariableName(n), ReferenceType.InTextBlocks);
                        }
                        trackVariableUsagesInText(n);
                    });
                }
                function trackAutoDeclaration(n) {
                    autoDeclarations.push([getVariableName(n.name), n]);
                }
                function addVariableDeclaration(node) {
                    if (node.name.kind !== SK.Identifier) {
                        error(node, pxtc.Util.lf("Variable declarations may not use binding patterns"));
                        return false;
                    }
                    else if (!node.initializer) {
                        error(node, pxtc.Util.lf("Variable declarations must have an initializer"));
                        return false;
                    }
                    return true;
                }
                function getVariableName(name) {
                    if (renameMap) {
                        const rename = renameMap.getRenameForPosition(name.getStart());
                        if (rename) {
                            return rename.name;
                        }
                    }
                    return name.text;
                }
            }
            decompiler.decompileToBlocks = decompileToBlocks;
            function checkStatement(node, env, asExpression = false, topLevel = false) {
                switch (node.kind) {
                    case SK.WhileStatement:
                    case SK.IfStatement:
                    case SK.Block:
                        return undefined;
                    case SK.ExpressionStatement:
                        return checkStatement(node.expression, env, asExpression, topLevel);
                    case SK.VariableStatement:
                        return checkVariableStatement(node, env);
                    case SK.CallExpression:
                        return checkCall(node, env, asExpression, topLevel);
                    case SK.VariableDeclaration:
                        return checkVariableDeclaration(node, env);
                    case SK.PostfixUnaryExpression:
                    case SK.PrefixUnaryExpression:
                        return checkIncrementorExpression(node);
                    case SK.FunctionExpression:
                    case SK.ArrowFunction:
                        return checkArrowFunction(node, env);
                    case SK.BinaryExpression:
                        return checkBinaryExpression(node, env);
                    case SK.ForStatement:
                        return checkForStatement(node);
                    case SK.ForOfStatement:
                        return checkForOfStatement(node);
                    case SK.FunctionDeclaration:
                        return checkFunctionDeclaration(node, topLevel);
                    case SK.EnumDeclaration:
                        return checkEnumDeclaration(node, topLevel);
                    case SK.ModuleDeclaration:
                        return checkNamespaceDeclaration(node);
                    case SK.ReturnStatement:
                        return checkReturnStatement(node);
                    case SK.BreakStatement:
                    case SK.ContinueStatement:
                    case SK.DebuggerStatement:
                    case SK.EmptyStatement:
                        return undefined;
                }
                return pxtc.Util.lf("Unsupported statement in block: {0}", SK[node.kind]);
                function checkForStatement(n) {
                    if (!n.initializer || !n.incrementor || !n.condition) {
                        return pxtc.Util.lf("for loops must have an initializer, incrementor, and condition");
                    }
                    if (n.initializer.kind !== SK.VariableDeclarationList) {
                        return pxtc.Util.lf("only variable declarations are permitted in for loop initializers");
                    }
                    const initializer = n.initializer;
                    if (!initializer.declarations) {
                        return pxtc.Util.lf("for loop with out-of-scope variables not supported");
                    }
                    if (initializer.declarations.length != 1) {
                        return pxtc.Util.lf("for loop with multiple variables not supported");
                    }
                    const assignment = initializer.declarations[0];
                    if (assignment.initializer.kind !== SK.NumericLiteral || assignment.initializer.text !== "0") {
                        return pxtc.Util.lf("for loop initializers must be initialized to 0");
                    }
                    const indexVar = assignment.name.text;
                    if (!incrementorIsValid(indexVar)) {
                        return pxtc.Util.lf("for loop incrementors may only increment the variable declared in the initializer");
                    }
                    if (n.condition.kind !== SK.BinaryExpression) {
                        return pxtc.Util.lf("for loop conditionals must be binary comparison operations");
                    }
                    const condition = n.condition;
                    if (condition.left.kind !== SK.Identifier || condition.left.text !== indexVar) {
                        return pxtc.Util.lf("left side of for loop conditional must be the variable declared in the initializer");
                    }
                    if (condition.operatorToken.kind !== SK.LessThanToken && condition.operatorToken.kind !== SK.LessThanEqualsToken) {
                        return pxtc.Util.lf("for loop conditional operator must be either < or <=");
                    }
                    return undefined;
                    function incrementorIsValid(varName) {
                        if (n.incrementor.kind === SK.PostfixUnaryExpression || n.incrementor.kind === SK.PrefixUnaryExpression) {
                            const incrementor = n.incrementor;
                            if (incrementor.operator === SK.PlusPlusToken && incrementor.operand.kind === SK.Identifier) {
                                return incrementor.operand.text === varName;
                            }
                        }
                        return false;
                    }
                }
                function checkForOfStatement(n) {
                    if (n.initializer.kind !== SK.VariableDeclarationList) {
                        return pxtc.Util.lf("only variable declarations are permitted in for of loop initializers");
                    }
                    // VariableDeclarationList in ForOfStatements are guranteed to have one declaration
                    return undefined;
                }
                function checkBinaryExpression(n, env) {
                    if (n.left.kind === SK.ElementAccessExpression) {
                        if (n.operatorToken.kind !== SK.EqualsToken) {
                            return pxtc.Util.lf("Element access expressions may only be assigned to using the equals operator");
                        }
                    }
                    else if (n.left.kind === SK.PropertyAccessExpression) {
                        if (n.operatorToken.kind !== SK.EqualsToken &&
                            n.operatorToken.kind !== SK.PlusEqualsToken) {
                            return pxtc.Util.lf("Property access expressions may only be assigned to using the = and += operators");
                        }
                        else {
                            return checkExpression(n.left, env);
                        }
                    }
                    else if (n.left.kind === SK.Identifier) {
                        switch (n.operatorToken.kind) {
                            case SK.EqualsToken:
                                return checkExpression(n.right, env);
                            case SK.PlusEqualsToken:
                            case SK.MinusEqualsToken:
                                return undefined;
                            default:
                                return pxtc.Util.lf("Unsupported operator token in statement {0}", SK[n.operatorToken.kind]);
                        }
                    }
                    else {
                        return pxtc.Util.lf("This expression cannot be assigned to");
                    }
                    return undefined;
                }
                function checkArrowFunction(n, env) {
                    let fail = false;
                    if (n.parameters.length) {
                        let parent = getParent(n)[0];
                        if (parent && pxtc.pxtInfo(parent).callInfo) {
                            let callInfo = pxtc.pxtInfo(parent).callInfo;
                            if (env.attrs(callInfo).mutate === "objectdestructuring") {
                                fail = n.parameters[0].name.kind !== SK.ObjectBindingPattern;
                            }
                            else {
                                fail = n.parameters.some(param => param.name.kind !== SK.Identifier);
                            }
                        }
                    }
                    if (fail) {
                        return pxtc.Util.lf("Unsupported parameters in error function");
                    }
                    return undefined;
                }
                function checkIncrementorExpression(n) {
                    if (n.operand.kind != SK.Identifier) {
                        return pxtc.Util.lf("-- and ++ may only be used on an identifier");
                    }
                    if (n.operator !== SK.PlusPlusToken && n.operator !== SK.MinusMinusToken) {
                        return pxtc.Util.lf("Only ++ and -- supported as prefix or postfix unary operators in a statement");
                    }
                    return undefined;
                }
                function checkVariableDeclaration(n, env) {
                    let check;
                    if (n.name.kind !== SK.Identifier) {
                        check = pxtc.Util.lf("Variable declarations may not use binding patterns");
                    }
                    else if (!n.initializer) {
                        check = pxtc.Util.lf("Variable declarations must have an initializer");
                    }
                    else if (!isAutoDeclaration(n)) {
                        check = checkExpression(n.initializer, env);
                    }
                    return check;
                }
                function checkVariableStatement(n, env) {
                    for (const declaration of n.declarationList.declarations) {
                        const res = checkVariableDeclaration(declaration, env);
                        if (res) {
                            return res;
                        }
                    }
                    return undefined;
                }
                function checkCall(n, env, asExpression = false, topLevel = false) {
                    const info = pxtc.pxtInfo(n).callInfo;
                    if (!info) {
                        return pxtc.Util.lf("Function call not supported in the blocks");
                    }
                    const attributes = env.attrs(info);
                    let userFunction;
                    if (ts.isIdentifier(n.expression)) {
                        userFunction = env.declaredFunctions[n.expression.text];
                    }
                    if (!asExpression) {
                        if (info.isExpression && !userFunction) {
                            const alias = env.aliasBlocks[info.qName];
                            if (alias) {
                                info.decompilerBlockAlias = env.aliasBlocks[info.qName];
                            }
                            else {
                                return pxtc.Util.lf("No output expressions as statements");
                            }
                        }
                    }
                    if (info.qName == "Math.pow") {
                        return undefined;
                    }
                    else if (pxt.Util.startsWith(info.qName, "Math.")) {
                        const op = info.qName.substring(5);
                        if (isSupportedMathFunction(op)) {
                            return undefined;
                        }
                    }
                    if (attributes.blockId === pxtc.PAUSE_UNTIL_TYPE) {
                        const predicate = n.arguments[0];
                        if (n.arguments.length === 1 && checkPredicate(predicate)) {
                            return undefined;
                        }
                        return pxtc.Util.lf("Predicates must be inline expressions that return a value");
                    }
                    const hasCallback = hasStatementInput(info, attributes);
                    if (hasCallback && !attributes.handlerStatement && !topLevel) {
                        return pxtc.Util.lf("Events must be top level");
                    }
                    if (!attributes.blockId || !attributes.block) {
                        const builtin = pxt.blocks.builtinFunctionInfo[info.qName];
                        if (!builtin) {
                            if (!userFunction) {
                                return pxtc.Util.lf("Call statements must have a valid declared function");
                            }
                            else if (userFunction.parameters.length !== info.args.length) {
                                return pxtc.Util.lf("Function calls in blocks must have the same number of arguments as the function definition");
                            }
                            else {
                                return undefined;
                            }
                        }
                        attributes.blockId = builtin.blockId;
                    }
                    const args = paramList(info, env.blocks);
                    const api = env.blocks.apis.byQName[info.qName];
                    const comp = pxt.blocks.compileInfo(api);
                    const totalDecompilableArgs = comp.parameters.length + (comp.thisParameter ? 1 : 0);
                    if (attributes.imageLiteral) {
                        // Image literals do not show up in the block string, so it won't be in comp
                        if (info.args.length - totalDecompilableArgs > 1) {
                            return pxtc.Util.lf("Function call has more arguments than are supported by its block");
                        }
                        let arg = n.arguments[0];
                        if (arg.kind != SK.StringLiteral && arg.kind != SK.NoSubstitutionTemplateLiteral) {
                            return pxtc.Util.lf("Only string literals supported for image literals");
                        }
                        const leds = (arg.text || '').replace(/\s+/g, '');
                        const nr = attributes.imageLiteralRows || 5;
                        const nc = (attributes.imageLiteralColumns || 5) * attributes.imageLiteral;
                        const nleds = nc * nr;
                        if (nc * nr != leds.length) {
                            return pxtc.Util.lf("Invalid image pattern ({0} expected vs {1} actual)", nleds, leds.length);
                        }
                        return undefined;
                    }
                    const argumentDifference = info.args.length - totalDecompilableArgs;
                    if (argumentDifference > 0 && !checkForDestructuringMutation()) {
                        let diff = argumentDifference;
                        // Callbacks and default instance parameters do not appear in the block
                        // definition string so they won't show up in the above count
                        if (hasCallback)
                            diff--;
                        if (attributes.defaultInstance)
                            diff--;
                        if (diff > 0) {
                            return pxtc.Util.lf("Function call has more arguments than are supported by its block");
                        }
                    }
                    if (comp.parameters.length || hasCallback) {
                        let fail;
                        const instance = attributes.defaultInstance || !!comp.thisParameter;
                        args.forEach((arg, i) => {
                            if (fail || instance && i === 0) {
                                return;
                            }
                            if (instance)
                                i--;
                            fail = checkArgument(arg);
                        });
                        if (fail) {
                            return fail;
                        }
                    }
                    if (api) {
                        const ns = env.blocks.apis.byQName[api.namespace];
                        if (ns && ns.attributes.fixedInstances && !ns.attributes.decompileIndirectFixedInstances && info.args.length) {
                            const callInfo = pxtc.pxtInfo(info.args[0]).callInfo;
                            if (!callInfo || !env.attrs(callInfo).fixedInstance) {
                                return pxtc.Util.lf("Fixed instance APIs can only be called directly from the fixed instance");
                            }
                        }
                    }
                    return undefined;
                    function checkForDestructuringMutation() {
                        // If the mutatePropertyEnum is set, the array literal and the destructured
                        // properties must have matching names
                        if (attributes.mutatePropertyEnum && argumentDifference === 2 && info.args.length >= 2) {
                            const arrayArg = info.args[info.args.length - 2];
                            const callbackArg = info.args[info.args.length - 1];
                            if (arrayArg.kind === SK.ArrayLiteralExpression && isFunctionExpression(callbackArg)) {
                                const propNames = [];
                                // Make sure that all elements in the array literal are enum values
                                const allLiterals = !arrayArg.elements.some((e) => {
                                    if (e.kind === SK.PropertyAccessExpression && e.expression.kind === SK.Identifier) {
                                        propNames.push(e.name.text);
                                        return e.expression.text !== attributes.mutatePropertyEnum;
                                    }
                                    return true;
                                });
                                if (allLiterals) {
                                    // Also need to check that the array literal's values and the destructured values match
                                    const bindings = getObjectBindingProperties(callbackArg);
                                    if (bindings) {
                                        const names = bindings[0];
                                        return names.length === propNames.length && !propNames.some(p => names.indexOf(p) === -1);
                                    }
                                }
                            }
                        }
                        return false;
                    }
                    function checkPredicate(p) {
                        if (p.kind !== SK.FunctionExpression && p.kind !== SK.ArrowFunction) {
                            return false;
                        }
                        const predicate = p;
                        if (isOutputExpression(predicate.body)) {
                            return true;
                        }
                        const body = predicate.body;
                        if (body.statements.length === 1) {
                            const stmt = unwrapNode(body.statements[0]);
                            if (stmt.kind === SK.ReturnStatement) {
                                return true;
                            }
                        }
                        return false;
                    }
                    function checkArgument(arg) {
                        const e = unwrapNode(arg.value);
                        const paramInfo = arg.info;
                        const param = arg.param;
                        if (paramInfo.isEnum) {
                            if (checkEnumArgument(e)) {
                                return undefined;
                            }
                            else if (e.kind === SK.CallExpression) {
                                const callInfo = pxtc.pxtInfo(e).callInfo;
                                const attributes = env.attrs(callInfo);
                                if (callInfo && attributes.shim === "TD_ID" && callInfo.args && callInfo.args.length === 1) {
                                    const arg = unwrapNode(callInfo.args[0]);
                                    if (checkEnumArgument(arg)) {
                                        return undefined;
                                    }
                                }
                            }
                            else if (e.kind === SK.Identifier) {
                                const attributes = pxtc.pxtInfo(e).commentAttrs;
                                if (attributes && attributes.enumIdentity)
                                    return undefined;
                            }
                            return pxtc.Util.lf("Enum arguments may only be literal property access expressions");
                        }
                        else if (isLiteralNode(e) && (param.fieldEditor || param.shadowBlockId)) {
                            let dl = !!(param.fieldOptions && param.fieldOptions[DecompileParamKeys.DecompileLiterals]);
                            if (!dl && param.shadowBlockId) {
                                const shadowInfo = env.blocks.blocksById[param.shadowBlockId];
                                if (shadowInfo && shadowInfo.parameters && shadowInfo.parameters.length) {
                                    const name = shadowInfo.parameters[0].name;
                                    if (shadowInfo.attributes.paramFieldEditorOptions && shadowInfo.attributes.paramFieldEditorOptions[name]) {
                                        dl = !!(shadowInfo.attributes.paramFieldEditorOptions[name][DecompileParamKeys.DecompileLiterals]);
                                    }
                                    else {
                                        dl = true;
                                    }
                                }
                                else {
                                    dl = true;
                                }
                            }
                            if (!dl) {
                                return pxtc.Util.lf("Field editor does not support literal arguments");
                            }
                        }
                        else if (e.kind === SK.TaggedTemplateExpression && param.fieldEditor) {
                            let tagName = param.fieldOptions && param.fieldOptions[DecompileParamKeys.TaggedTemplate];
                            if (!tagName) {
                                return pxtc.Util.lf("Tagged templates only supported in custom fields with param.fieldOptions.taggedTemplate set");
                            }
                            const tag = unwrapNode(e.tag);
                            if (tag.kind !== SK.Identifier) {
                                return pxtc.Util.lf("Tagged template literals must use an identifier as the tag");
                            }
                            const tagText = tag.getText();
                            if (tagText.trim() != tagName.trim()) {
                                return pxtc.Util.lf("Function only supports template literals with tag '{0}'", tagName);
                            }
                            const template = e.template;
                            if (template.kind !== SK.NoSubstitutionTemplateLiteral) {
                                return pxtc.Util.lf("Tagged template literals cannot have substitutions");
                            }
                        }
                        else if (e.kind === SK.ArrowFunction) {
                            const ar = e;
                            if (ar.parameters.length) {
                                if (attributes.mutate === "objectdestructuring") {
                                    const param = unwrapNode(ar.parameters[0]);
                                    if (param.kind === SK.Parameter && param.name.kind !== SK.ObjectBindingPattern) {
                                        return pxtc.Util.lf("Object destructuring mutation callbacks can only have destructuring patters as arguments");
                                    }
                                }
                                else {
                                    for (const param of ar.parameters) {
                                        if (param.name.kind !== SK.Identifier) {
                                            return pxtc.Util.lf("Only identifiers allowed as function arguments");
                                        }
                                    }
                                }
                            }
                        }
                        else if (env.blocks.apis.byQName[paramInfo.type]) {
                            const typeInfo = env.blocks.apis.byQName[paramInfo.type];
                            if (typeInfo.attributes.fixedInstances) {
                                if (decompileFixedInst(param)) {
                                    return undefined;
                                }
                                else if (param.shadowBlockId) {
                                    const shadowSym = env.blocks.blocksById[param.shadowBlockId];
                                    if (shadowSym) {
                                        const shadowInfo = pxt.blocks.compileInfo(shadowSym);
                                        if (shadowInfo.parameters && decompileFixedInst(shadowInfo.parameters[0])) {
                                            return undefined;
                                        }
                                    }
                                }
                                const callInfo = pxtc.pxtInfo(e).callInfo;
                                if (callInfo && env.attrs(callInfo).fixedInstance) {
                                    return undefined;
                                }
                                return pxtc.Util.lf("Arguments of a fixed instance type must be a reference to a fixed instance declaration");
                            }
                        }
                        return undefined;
                        function checkEnumArgument(enumArg) {
                            // Enums can be under namespaces, so split up the qualified name into parts
                            const parts = paramInfo.type.split(".");
                            const enumParts = [];
                            while (enumArg.kind === SK.PropertyAccessExpression) {
                                enumParts.unshift(enumArg.name.text);
                                enumArg = enumArg.expression;
                            }
                            if (enumArg.kind !== SK.Identifier) {
                                return false;
                            }
                            enumParts.unshift(enumArg.text);
                            // Use parts.length, because enumParts also contains the enum member
                            for (let i = 0; i < parts.length; i++) {
                                if (parts[i] !== enumParts[i])
                                    return false;
                            }
                            return true;
                        }
                    }
                }
                function checkFunctionDeclaration(n, topLevel) {
                    if (!topLevel) {
                        return pxtc.Util.lf("Function declarations must be top level");
                    }
                    if (n.parameters.length > 0) {
                        if (env.opts.allowedArgumentTypes) {
                            for (const param of n.parameters) {
                                if (param.initializer || param.questionToken) {
                                    return pxtc.Util.lf("Function parameters cannot be optional");
                                }
                                const type = param.type ? param.type.getText() : undefined;
                                if (!type) {
                                    return pxtc.Util.lf("Function parameters must declare a type");
                                }
                                const normalized = normalizeType(type);
                                if (env.opts.allowedArgumentTypes.indexOf(normalized) === -1 && !pxtc.U.endsWith(normalized, "[]")) {
                                    return pxtc.Util.lf("Only types that can be added in blocks can be used for function arguments");
                                }
                            }
                        }
                    }
                    return undefined;
                }
                function checkEnumDeclaration(n, topLevel) {
                    if (!topLevel)
                        return pxtc.Util.lf("Enum declarations must be top level");
                    const name = n.name.text;
                    const info = env.blocks.enumsByName[name];
                    if (!info)
                        return pxtc.Util.lf("Enum declarations in user code must have a block");
                    let fail = false;
                    // Initializers can either be a numeric literal or of the form a << b
                    n.members.forEach(member => {
                        if (member.name.kind !== SK.Identifier)
                            fail = true;
                        if (fail)
                            return;
                        if (member.initializer) {
                            if (member.initializer.kind === SK.NumericLiteral) {
                                return;
                            }
                            else if (member.initializer.kind === SK.BinaryExpression) {
                                const ex = member.initializer;
                                if (ex.operatorToken.kind === SK.LessThanLessThanToken) {
                                    if (ex.left.kind === SK.NumericLiteral && ex.right.kind === SK.NumericLiteral) {
                                        if (ex.left.text == "1") {
                                            return;
                                        }
                                    }
                                }
                            }
                            fail = true;
                        }
                    });
                    if (fail) {
                        return pxtc.Util.lf("Invalid initializer for enum member");
                    }
                    return undefined;
                }
                function checkNamespaceDeclaration(n) {
                    const kindCheck = checkKindNamespaceDeclaration(n, env);
                    if (!kindCheck)
                        return undefined;
                    const tilesetCheck = checkTilesetNamespace(n);
                    if (!tilesetCheck)
                        return undefined;
                    return kindCheck;
                }
                function checkReturnStatement(n) {
                    if (checkIfWithinFunction(n)) {
                        return undefined;
                    }
                    return pxtc.Util.lf("Return statements can only be used within top-level function declarations");
                    function checkIfWithinFunction(n) {
                        const enclosing = ts.getEnclosingBlockScopeContainer(n);
                        if (enclosing) {
                            switch (enclosing.kind) {
                                case SK.SourceFile:
                                case SK.ArrowFunction:
                                case SK.FunctionExpression:
                                    return false;
                                case SK.FunctionDeclaration:
                                    return enclosing.parent && enclosing.parent.kind === SK.SourceFile && !checkStatement(enclosing, env, false, true);
                                default:
                                    return checkIfWithinFunction(enclosing);
                            }
                        }
                        return false;
                    }
                }
            }
            function checkKindNamespaceDeclaration(n, env) {
                if (!ts.isModuleBlock(n.body)) {
                    return pxtc.Util.lf("Namespaces cannot be nested.");
                }
                const kindInfo = env.blocks.kindsByName[n.name.text];
                if (!kindInfo) {
                    return pxtc.Util.lf("Only namespaces with 'kind' blocks can be decompiled");
                }
                const fail = pxtc.Util.lf("Namespaces may only contain valid 'kind' exports");
                // Each statement must be of the form `export const kind = kindNamespace.create()`
                for (const statement of n.body.statements) {
                    // There isn't really a way to persist comments, so to be safe just bail out
                    if (isCommented(statement))
                        return fail;
                    if (ts.isVariableStatement(statement) && statement.declarationList.declarations) {
                        const isSingleDeclaration = statement.declarationList.declarations.length === 1;
                        const isExport = statement.modifiers && statement.modifiers.length === 1 && statement.modifiers[0].kind === SK.ExportKeyword;
                        const isConst = statement.declarationList.flags & ts.NodeFlags.Const;
                        if (isSingleDeclaration && isExport && isConst) {
                            const declaration = statement.declarationList.declarations[0];
                            if (!declaration.initializer || !ts.isCallExpression(declaration.initializer) || !ts.isIdentifier(declaration.name)) {
                                return fail;
                            }
                            const call = declaration.initializer;
                            if (call.arguments.length) {
                                return fail;
                            }
                            // The namespace is emitted from the blocks, but it's optional when decompiling
                            if (ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression)) {
                                if (call.expression.expression.text !== kindInfo.name || call.expression.name.text !== kindInfo.createFunctionName)
                                    return fail;
                            }
                            else if (ts.isIdentifier(call.expression)) {
                                if (call.expression.text !== kindInfo.createFunctionName)
                                    return fail;
                            }
                            else {
                                return fail;
                            }
                        }
                        else {
                            return fail;
                        }
                    }
                    else {
                        return fail;
                    }
                }
                return undefined;
            }
            function checkTilesetNamespace(n) {
                if (!ts.isModuleBlock(n.body)) {
                    return pxtc.Util.lf("Namespaces cannot be nested.");
                }
                if (n.name.text !== pxt.sprite.TILE_NAMESPACE) {
                    return pxtc.Util.lf("Tileset namespace must be named myTiles");
                }
                const fail = pxtc.Util.lf("The myTiles namespace can only export tile variables with image literal initializers and no duplicate ids");
                const commentFail = pxtc.Util.lf("Tileset members must have a blockIdentity comment and no other annotations");
                const nameRegex = new RegExp(`${pxt.sprite.TILE_PREFIX}(\\d+)`);
                const foundIds = [];
                const commentRegex = /^\s*\/\/%\s*blockIdentity=[^\s]+\s*$/;
                // Each statement must be of the form "export const tile{ID} = img``;"
                for (const statement of n.body.statements) {
                    // Tile members have a single annotation of the form "//% blockIdentity=..."
                    // Bail out on any other comment because we can't persist it
                    const commentRanges = ts.getLeadingCommentRangesOfNode(statement, statement.getSourceFile());
                    if (commentRanges && commentRanges.length) {
                        const comments = commentRanges.map(cr => statement.getSourceFile().text.substr(cr.pos, cr.end - cr.pos)).filter(c => !!c);
                        if (comments.length !== 1 || !commentRegex.test(comments[0])) {
                            return commentFail;
                        }
                    }
                    else {
                        return commentFail;
                    }
                    if (ts.isVariableStatement(statement) && statement.declarationList.declarations) {
                        const isSingleDeclaration = statement.declarationList.declarations.length === 1;
                        const isExport = statement.modifiers && statement.modifiers.length === 1 && statement.modifiers[0].kind === SK.ExportKeyword;
                        const isConst = statement.declarationList.flags & ts.NodeFlags.Const;
                        if (isSingleDeclaration && isExport && isConst) {
                            const declaration = statement.declarationList.declarations[0];
                            if (!declaration.initializer || !ts.isTaggedTemplateExpression(declaration.initializer) || !ts.isIdentifier(declaration.name)) {
                                return fail;
                            }
                            const tag = declaration.initializer;
                            if (!ts.isIdentifier(tag.tag) || tag.tag.text !== "img") {
                                return fail;
                            }
                            const match = nameRegex.exec(declaration.name.text);
                            if (!match || foundIds.indexOf(match[1]) !== -1) {
                                return fail;
                            }
                            foundIds.push(match[1]);
                        }
                        else {
                            return fail;
                        }
                    }
                    else {
                        return fail;
                    }
                }
                return undefined;
            }
            function isEmptyStringNode(node) {
                if (node.kind === SK.StringLiteral || node.kind === SK.NoSubstitutionTemplateLiteral) {
                    return node.text === "";
                }
                return false;
            }
            function isAutoDeclaration(decl) {
                if (decl.initializer) {
                    if (decl.initializer.kind === ts.SyntaxKind.NullKeyword || decl.initializer.kind === ts.SyntaxKind.FalseKeyword || isDefaultArray(decl.initializer)) {
                        return true;
                    }
                    else if (ts.isStringOrNumericLiteral(decl.initializer)) {
                        const text = decl.initializer.getText();
                        return text === "0" || isEmptyString(text);
                    }
                    else {
                        const callInfo = pxtc.pxtInfo(decl.initializer).callInfo;
                        if (callInfo && callInfo.isAutoCreate)
                            return true;
                    }
                }
                return false;
            }
            function isDefaultArray(e) {
                return e.kind === SK.ArrayLiteralExpression && e.elements.length === 0;
            }
            function getObjectBindingProperties(callback) {
                if (callback.parameters.length === 1 && callback.parameters[0].name.kind === SK.ObjectBindingPattern) {
                    const elements = callback.parameters[0].name.elements;
                    const renames = {};
                    const properties = elements.map(e => {
                        if (checkName(e.propertyName) && checkName(e.name)) {
                            const name = e.name.text;
                            if (e.propertyName) {
                                const propName = e.propertyName.text;
                                renames[propName] = name;
                                return propName;
                            }
                            return name;
                        }
                        else {
                            return "";
                        }
                    });
                    return [properties, renames];
                }
                return undefined;
                function checkName(name) {
                    if (name && name.kind !== SK.Identifier) {
                        // error(name, Util.lf("Only identifiers may be used for variable names in object destructuring patterns"));
                        return false;
                    }
                    return true;
                }
            }
            function checkExpression(n, env) {
                switch (n.kind) {
                    case SK.NumericLiteral:
                    case SK.TrueKeyword:
                    case SK.FalseKeyword:
                    case SK.ExpressionStatement:
                    case SK.ArrayLiteralExpression:
                    case SK.ElementAccessExpression:
                        return undefined;
                    case SK.ParenthesizedExpression:
                        return checkExpression(n.expression, env);
                    case SK.StringLiteral:
                    case SK.FirstTemplateToken:
                    case SK.NoSubstitutionTemplateLiteral:
                        return checkStringLiteral(n);
                    case SK.Identifier:
                        const pInfo = pxtc.pxtInfo(n);
                        if (isUndefined(n)) {
                            return pxtc.Util.lf("Undefined is not supported in blocks");
                        }
                        else if (isDeclaredElsewhere(n) && !(pInfo.commentAttrs && pInfo.commentAttrs.blockIdentity && pInfo.commentAttrs.enumIdentity)) {
                            return pxtc.Util.lf("Variable is declared in another file");
                        }
                        else {
                            return undefined;
                        }
                    case SK.BinaryExpression:
                        const op1 = n.operatorToken.getText();
                        return ops[op1] ? undefined : pxtc.Util.lf("Could not find operator {0}", op1);
                    case SK.PrefixUnaryExpression:
                        const op2 = n.operator;
                        return op2 === SK.MinusToken || op2 === SK.PlusToken || op2 === SK.ExclamationToken ?
                            undefined : pxtc.Util.lf("Unsupported prefix unary operator{0}", op2);
                    case SK.PropertyAccessExpression:
                        return checkPropertyAccessExpression(n, env);
                    case SK.CallExpression:
                        return checkStatement(n, env, true, undefined);
                    case SK.TaggedTemplateExpression:
                        return checkTaggedTemplateExpression(n, env);
                    case SK.AsExpression:
                        return checkAsExpression(n);
                }
                return pxtc.Util.lf("Unsupported syntax kind for output expression block: {0}", SK[n.kind]);
                function checkStringLiteral(n) {
                    const literal = n.text;
                    return validStringRegex.test(literal) ? undefined : pxtc.Util.lf("Only whitespace character allowed in string literals is space");
                }
                function checkPropertyAccessExpression(n, env) {
                    const callInfo = pxtc.pxtInfo(n).callInfo;
                    if (callInfo) {
                        const attributes = env.attrs(callInfo);
                        const blockInfo = env.compInfo(callInfo);
                        if (attributes.blockIdentity || attributes.blockId === "lists_length" || attributes.blockId === "text_length") {
                            return undefined;
                        }
                        else if (callInfo.decl.kind === SK.EnumMember) {
                            // Check to see if this an enum with a block
                            if (n.expression.kind === SK.Identifier) {
                                const enumName = n.expression.text;
                                if (env.declaredEnums[enumName])
                                    return undefined;
                            }
                            // Otherwise make sure this is in a dropdown on the block
                            const [parent, child] = getParent(n);
                            let fail = true;
                            if (parent) {
                                const parentInfo = pxtc.pxtInfo(parent).callInfo;
                                if (parentInfo && parentInfo.args) {
                                    const api = env.blocks.apis.byQName[parentInfo.qName];
                                    const instance = api.kind == 1 /* Method */ || api.kind == 2 /* Property */;
                                    if (api) {
                                        parentInfo.args.forEach((arg, i) => {
                                            if (arg === child) {
                                                const paramInfo = api.parameters[instance ? i - 1 : i];
                                                if (paramInfo.isEnum) {
                                                    fail = false;
                                                }
                                            }
                                        });
                                    }
                                }
                            }
                            if (fail) {
                                return pxtc.Util.lf("Enum value without a corresponding block");
                            }
                            else {
                                return undefined;
                            }
                        }
                        else if (attributes.fixedInstance && n.parent) {
                            // Check if this is a fixedInstance with a method being called on it
                            if (n.parent.parent && n.parent.kind === SK.PropertyAccessExpression && n.parent.parent.kind === SK.CallExpression) {
                                const call = n.parent.parent;
                                if (call.expression === n.parent) {
                                    return undefined;
                                }
                            }
                            // Check if this fixedInstance is an argument passed to a function
                            else if (n.parent.kind === SK.CallExpression && n.parent.expression !== n) {
                                return undefined;
                            }
                        }
                        else if (attributes.blockCombine || (attributes.blockId && blockInfo && blockInfo.thisParameter)) {
                            // block combine and getters/setters
                            return checkExpression(n.expression, env);
                        }
                        else if (ts.isIdentifier(n.expression) && env.declaredKinds[n.expression.text]) {
                            const propName = n.name.text;
                            const kind = env.declaredKinds[n.expression.text];
                            if (kind && (kind.kindInfo.initialMembers.indexOf(propName) !== -1 || kind.declaredNames.indexOf(propName) !== -1)) {
                                return undefined;
                            }
                        }
                    }
                    return pxtc.Util.lf("No call info found");
                }
            }
            function checkTaggedTemplateExpression(t, env) {
                const callInfo = pxtc.pxtInfo(t).callInfo;
                if (!callInfo) {
                    return pxtc.Util.lf("Invalid tagged template");
                }
                const attributes = env.attrs(callInfo);
                if (!attributes.blockIdentity) {
                    return pxtc.Util.lf("Tagged template does not have blockIdentity set");
                }
                const api = env.blocks.apis.byQName[attributes.blockIdentity];
                if (!api) {
                    return pxtc.Util.lf("Could not find blockIdentity for tagged template");
                }
                const comp = pxt.blocks.compileInfo(api);
                if (comp.parameters.length !== 1) {
                    return pxtc.Util.lf("Tagged template functions must have 1 argument");
                }
                // The compiler will have already caught any invalid tags or templates
                return undefined;
            }
            function checkAsExpression(n) {
                // The only time we allow casts to decompile is in the very special case where someone has
                // written a program comparing two string, boolean, or numeric literals in blocks and
                // converted to text. e.g. 3 == 5 or true != false
                if (n.type.getText().trim() === "any" && (ts.isStringOrNumericLiteral(n.expression) ||
                    n.expression.kind === SK.TrueKeyword || n.expression.kind === SK.FalseKeyword)) {
                    const [parent] = getParent(n);
                    if (parent.kind === SK.BinaryExpression) {
                        switch (parent.operatorToken.kind) {
                            case SK.EqualsEqualsToken:
                            case SK.EqualsEqualsEqualsToken:
                            case SK.ExclamationEqualsToken:
                            case SK.ExclamationEqualsEqualsToken:
                            case SK.LessThanToken:
                            case SK.LessThanEqualsToken:
                            case SK.GreaterThanToken:
                            case SK.GreaterThanEqualsToken:
                                return undefined;
                            default:
                                break;
                        }
                    }
                }
                return pxtc.Util.lf("Casting not supported in blocks");
            }
            function getParent(node) {
                if (!node.parent) {
                    return [undefined, node];
                }
                else if (node.parent.kind === SK.ParenthesizedExpression) {
                    return getParent(node.parent);
                }
                else {
                    return [node.parent, node];
                }
            }
            function unwrapNode(node) {
                while (node.kind === SK.ParenthesizedExpression) {
                    node = node.expression;
                }
                return node;
            }
            function isEmptyString(a) {
                return a === `""` || a === `''` || a === "``";
            }
            function isUndefined(node) {
                return node && node.kind === SK.Identifier && node.text === "undefined";
            }
            function isDeclaredElsewhere(node) {
                return !!(pxtc.pxtInfo(node).flags & 4 /* IsGlobalIdentifier */);
            }
            function hasStatementInput(info, attributes) {
                if (attributes.blockId === pxtc.PAUSE_UNTIL_TYPE)
                    return false;
                const parameters = info.decl.parameters;
                return info.args.some((arg, index) => arg && isFunctionExpression(arg));
            }
            function isLiteralNode(node) {
                if (!node) {
                    return false;
                }
                switch (node.kind) {
                    case SK.ParenthesizedExpression:
                        return isLiteralNode(node.expression);
                    case SK.ArrayLiteralExpression:
                        const arr = node;
                        // Check to make sure all array elements are literals or tagged template literals (e.g. img``)
                        for (const el of arr.elements) {
                            if (!isLiteralNode(el) && el.kind !== SK.TaggedTemplateExpression) {
                                return false;
                            }
                        }
                        return true;
                    case SK.NumericLiteral:
                    case SK.StringLiteral:
                    case SK.NoSubstitutionTemplateLiteral:
                    case SK.TrueKeyword:
                    case SK.FalseKeyword:
                        return true;
                    case SK.PrefixUnaryExpression:
                        const expression = node;
                        return (expression.operator === SK.PlusToken || expression.operator === SK.MinusToken) && isLiteralNode(expression.operand);
                    default:
                        return false;
                }
            }
            function isFunctionExpression(node) {
                return node.kind === SK.ArrowFunction || node.kind === SK.FunctionExpression;
            }
            function paramList(info, blocksInfo) {
                const res = [];
                const sym = blocksInfo.apis.byQName[info.qName];
                if (sym) {
                    const attributes = blocksInfo.apis.byQName[info.qName].attributes;
                    const comp = pxt.blocks.compileInfo(sym);
                    const builtin = pxt.blocks.builtinFunctionInfo[info.qName];
                    let offset = attributes.imageLiteral ? 1 : 0;
                    if (comp.thisParameter) {
                        res.push({
                            value: unwrapNode(info.args[0]),
                            info: null,
                            param: comp.thisParameter
                        });
                    }
                    else if (attributes.defaultInstance) {
                        res.push({
                            value: unwrapNode(info.args[0]),
                            info: sym.parameters[0],
                            param: { definitionName: "__instance__", actualName: "this" }
                        });
                    }
                    const hasThisArgInSymbol = !!(comp.thisParameter || attributes.defaultInstance);
                    if (hasThisArgInSymbol) {
                        offset++;
                    }
                    for (let i = offset; i < info.args.length; i++) {
                        res.push({
                            value: unwrapNode(info.args[i]),
                            info: sym.parameters[hasThisArgInSymbol ? i - 1 : i],
                            param: comp.parameters[i - offset]
                        });
                    }
                }
                return res;
            }
            // This assumes the enum already passed checkEnumDeclaration
            function getEnumMembers(n) {
                const res = [];
                n.members.forEach(member => {
                    pxtc.U.assert(member.name.kind === SK.Identifier);
                    const name = member.name.text;
                    let value;
                    if (member.initializer) {
                        if (member.initializer.kind === SK.NumericLiteral) {
                            value = parseInt(member.initializer.text);
                        }
                        else {
                            const ex = member.initializer;
                            pxtc.U.assert(ex.left.kind === SK.NumericLiteral);
                            pxtc.U.assert(ex.left.text === "1");
                            pxtc.U.assert(ex.operatorToken.kind === SK.LessThanLessThanToken);
                            pxtc.U.assert(ex.right.kind === SK.NumericLiteral);
                            const shift = parseInt(ex.right.text);
                            value = 1 << shift;
                        }
                    }
                    else if (res.length === 0) {
                        value = 0;
                    }
                    else {
                        value = res[res.length - 1][1] + 1;
                    }
                    res.push([name, value]);
                });
                return res;
            }
            function getModuleExports(n) {
                return n.body.statements.map(s => {
                    const decl = s.declarationList.declarations[0];
                    return {
                        name: decl.name.text,
                        initializer: decl.initializer.getText()
                    };
                });
            }
            function isOutputExpression(expr) {
                switch (expr.kind) {
                    case SK.BinaryExpression:
                        const tk = expr.operatorToken.kind;
                        return tk != SK.PlusEqualsToken && tk != SK.MinusEqualsToken && tk != SK.EqualsToken;
                    case SK.PrefixUnaryExpression: {
                        let op = expr.operator;
                        return op != SK.PlusPlusToken && op != SK.MinusMinusToken;
                    }
                    case SK.PostfixUnaryExpression: {
                        let op = expr.operator;
                        return op != SK.PlusPlusToken && op != SK.MinusMinusToken;
                    }
                    case SK.CallExpression:
                        const callInfo = pxtc.pxtInfo(expr).callInfo;
                        pxtc.assert(!!callInfo);
                        return callInfo.isExpression;
                    case SK.ParenthesizedExpression:
                    case SK.NumericLiteral:
                    case SK.StringLiteral:
                    case SK.NoSubstitutionTemplateLiteral:
                    case SK.TrueKeyword:
                    case SK.FalseKeyword:
                    case SK.NullKeyword:
                    case SK.TaggedTemplateExpression:
                        return true;
                    default: return false;
                }
            }
            function isLiteralBlockType(type) {
                switch (type) {
                    case numberType:
                    case minmaxNumberType:
                    case integerNumberType:
                    case wholeNumberType:
                    case stringType:
                    case booleanType:
                        return true;
                    default:
                        return false;
                }
            }
            function decompileFixedInst(param) {
                return param && param.fieldOptions && param.fieldOptions[DecompileParamKeys.DecompileIndirectFixedInstances];
            }
            function isSupportedMathFunction(op) {
                return isUnaryMathFunction(op) || isInfixMathFunction(op) || isRoundingFunction(op) ||
                    pxt.blocks.MATH_FUNCTIONS.binary.indexOf(op) !== -1;
            }
            function isUnaryMathFunction(op) {
                return pxt.blocks.MATH_FUNCTIONS.unary.indexOf(op) !== -1;
            }
            function isInfixMathFunction(op) {
                return pxt.blocks.MATH_FUNCTIONS.infix.indexOf(op) !== -1;
            }
            function isRoundingFunction(op) {
                return pxt.blocks.ROUNDING_FUNCTIONS.indexOf(op) !== -1;
            }
            function normalizeType(type) {
                const match = arrayTypeRegex.exec(type);
                if (match) {
                    return `${match[1] || match[2]}[]`;
                }
                return type;
            }
            function isCommented(node) {
                const ranges = ts.getLeadingCommentRangesOfNode(node, node.getSourceFile());
                return !!(ranges && ranges.length);
            }
            function getCommentsFromRanges(file, commentRanges, isTrailingComment = false) {
                const res = [];
                const fileText = file.getFullText();
                if (commentRanges && commentRanges.length) {
                    for (const commentRange of commentRanges) {
                        const endLine = ts.getLineOfLocalPosition(file, commentRange.end);
                        const nextLineStart = ts.getStartPositionOfLine(endLine + 1, file) || fileText.length;
                        const nextLineEnd = ts.getStartPositionOfLine(endLine + 2, file) || fileText.length;
                        const followedByEmptyLine = !isTrailingComment && !fileText.substr(nextLineStart, nextLineEnd - nextLineStart).trim();
                        let commentText = fileText.substr(commentRange.pos, commentRange.end - commentRange.pos);
                        if (commentText) {
                            // Strip windows line endings because they break the regex we use to extract content
                            commentText = commentText.replace(/\r\n/g, "\n");
                        }
                        if (commentRange.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
                            const match = singleLineCommentRegex.exec(commentText);
                            if (match) {
                                res.push({
                                    kind: CommentKind.SingleLine,
                                    text: match[1],
                                    start: commentRange.pos,
                                    end: commentRange.end,
                                    hasTrailingNewline: !!commentRange.hasTrailingNewLine,
                                    followedByEmptyLine,
                                    isTrailingComment
                                });
                            }
                            else {
                                res.push({
                                    kind: CommentKind.SingleLine,
                                    text: "",
                                    start: commentRange.pos,
                                    end: commentRange.end,
                                    hasTrailingNewline: !!commentRange.hasTrailingNewLine,
                                    followedByEmptyLine,
                                    isTrailingComment
                                });
                            }
                        }
                        else {
                            const lines = commentText.split("\n").map(line => {
                                const match = multiLineCommentRegex.exec(line);
                                return match ? match[1] : "";
                            });
                            res.push({
                                kind: CommentKind.MultiLine,
                                lines,
                                start: commentRange.pos,
                                end: commentRange.end,
                                hasTrailingNewline: !!commentRange.hasTrailingNewLine,
                                followedByEmptyLine,
                                isTrailingComment
                            });
                        }
                    }
                }
                return res;
            }
            function formatCommentsForBlocks(comments) {
                let out = "";
                for (const comment of comments) {
                    if (comment.kind === CommentKind.SingleLine) {
                        if (comment.text === pxtc.ON_START_COMMENT || comment.text === pxtc.HANDLER_COMMENT) {
                            continue;
                        }
                        else {
                            out += comment.text.trim() + "\n";
                        }
                    }
                    else {
                        for (const line of comment.lines) {
                            out += line.trim() + "\n";
                        }
                    }
                }
                return out.trim();
            }
            function isTopLevelComment(n) {
                const [parent,] = getParent(n);
                if (!parent || parent.kind == SK.SourceFile)
                    return true;
                // Expression statement
                if (parent.kind == SK.ExpressionStatement)
                    return isTopLevelComment(parent);
                // Variable statement
                if (parent.kind == SK.VariableDeclarationList)
                    return isTopLevelComment(parent.parent);
                return false;
            }
            function getLeadingComments(node, file, commentRanges) {
                return getCommentsFromRanges(file, commentRanges || ts.getLeadingCommentRangesOfNode(node, file));
            }
            decompiler.getLeadingComments = getLeadingComments;
            function getTrailingComments(node, file) {
                return getCommentsFromRanges(file, ts.getTrailingCommentRanges(file.getFullText(), node.end));
            }
            decompiler.getTrailingComments = getTrailingComments;
            function getCommentsForStatement(commented, commentMap) {
                let comments = [];
                let current;
                for (let i = 0; i < commentMap.length; i++) {
                    current = commentMap[i];
                    if (!current.owner && current.start >= commented.pos && current.end <= commented.end) {
                        current.owner = commented;
                        comments.push(current);
                    }
                    if (current.start > commented.end)
                        break;
                }
                return comments;
            }
            decompiler.getCommentsForStatement = getCommentsForStatement;
            function buildCommentMap(file) {
                const fileText = file.getFullText();
                const scanner = ts.createScanner(file.languageVersion, false, file.languageVariant, fileText, undefined, file.getFullStart());
                let res = [];
                let leading;
                let trailing;
                while (scanner.getTextPos() < file.end) {
                    const val = scanner.scan();
                    if (val === SK.SingleLineCommentTrivia || val === SK.MultiLineCommentTrivia) {
                        leading = ts.getLeadingCommentRanges(fileText, scanner.getTokenPos()) || [];
                        trailing = ts.getTrailingCommentRanges(fileText, scanner.getTokenPos()) || [];
                        // Filter out duplicates
                        trailing = trailing.filter(range => !leading.some(other => other.pos === range.pos));
                        res.push(...getCommentsFromRanges(file, leading, false));
                        res.push(...getCommentsFromRanges(file, trailing, true));
                        for (const range of res) {
                            if (range.end > scanner.getTextPos()) {
                                scanner.setTextPos(range.end);
                            }
                        }
                    }
                }
                res.sort((a, b) => a.start - b.start);
                return res;
            }
            decompiler.buildCommentMap = buildCommentMap;
            function markCommentsInRange(node, commentMap) {
                let current;
                for (let i = 0; i < commentMap.length; i++) {
                    current = commentMap[i];
                    if (!current.owner && current.start >= node.pos && current.end <= node.end) {
                        current.owner = node;
                    }
                }
            }
            function shouldEmitShadowOnly(n) {
                let emitShadowOnly = false;
                if (n.value.kind === "expr") {
                    const value = n.value;
                    if (value.type === numberType && n.shadowType === minmaxNumberType) {
                        value.type = minmaxNumberType;
                        value.fields[0].name = 'SLIDER';
                        value.mutation = n.shadowMutation;
                    }
                    emitShadowOnly = value.type === n.shadowType;
                    if (!emitShadowOnly) {
                        switch (value.type) {
                            case "math_number":
                            case "math_number_minmax":
                            case "math_integer":
                            case "math_whole_number":
                            case "logic_boolean":
                            case "text":
                                emitShadowOnly = !n.shadowType;
                                break;
                        }
                    }
                }
                return emitShadowOnly;
            }
        })(decompiler = pxtc.decompiler || (pxtc.decompiler = {}));
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        var service;
        (function (service) {
            /**
             * Produces a markdown string for the symbol that is suitable for display in Monaco
             */
            function displayStringForSymbol(sym, python, apiInfo) {
                if (!sym)
                    return undefined;
                switch (sym.kind) {
                    case 3 /* Function */:
                    case 1 /* Method */:
                        return displayStringForFunction(sym, python, apiInfo);
                    case 6 /* Enum */:
                    case 7 /* EnumMember */:
                        return displayStringForEnum(sym, python);
                    case 5 /* Module */:
                        return displayStringForNamepsace(sym, python);
                    case 9 /* Interface */:
                        return displayStringForInterface(sym, python);
                    case 8 /* Class */:
                        return displayStringForClass(sym, python);
                    case 4 /* Variable */:
                        return displayStringForVariable(sym, python, apiInfo);
                    case 2 /* Property */:
                        return displayStringForProperty(sym, python, apiInfo);
                }
                return `**${sym.qName}**`;
            }
            service.displayStringForSymbol = displayStringForSymbol;
            function displayStringForKeyword(keyword, python) {
                return `\`\`\`${python ? "py" : "ts"}\n(keyword) ${keyword}\n\`\`\``;
            }
            service.displayStringForKeyword = displayStringForKeyword;
            function displayStringForFunction(sym, python, apiInfo) {
                let prefix = "";
                if (sym.kind === 3 /* Function */) {
                    prefix += python ? "def " : "function ";
                }
                else {
                    prefix += "(method) ";
                }
                prefix += python ? sym.pyQName : sym.qName;
                let argString = "";
                if (sym.parameters && sym.parameters.length) {
                    argString = sym.parameters.map(param => `${param.name}: ${python ? param.pyTypeString : param.type}`).join(", ");
                }
                let retType = sym.retType || "void";
                if (python) {
                    retType = getPythonReturnType(retType, apiInfo);
                }
                return codeBlock(`${prefix}(${argString}): ${retType}`, python);
            }
            function displayStringForEnum(sym, python) {
                const qName = python ? sym.pyQName : sym.qName;
                if (sym.kind === 6 /* Enum */) {
                    return codeBlock(`enum ${qName}`, python);
                }
                let memberString = `(enum member) ${qName}`;
                if (sym.attributes.enumval) {
                    memberString += ` = ${sym.attributes.enumval}`;
                }
                return codeBlock(memberString, false);
            }
            function displayStringForNamepsace(sym, python) {
                return codeBlock(`namespace ${python ? sym.pyQName : sym.qName}`, false);
            }
            function displayStringForInterface(sym, python) {
                return codeBlock(`interface ${python ? sym.pyQName : sym.qName}`, false);
            }
            function displayStringForClass(sym, python) {
                return codeBlock(`class ${python ? sym.pyQName : sym.qName}`, python);
            }
            function displayStringForVariable(sym, python, apiInfo) {
                let varString = python ? sym.pyQName : `let ${sym.qName}`;
                if (sym.retType) {
                    let retType = sym.retType;
                    if (python) {
                        retType = getPythonReturnType(retType, apiInfo);
                    }
                    return codeBlock(`${varString}: ${retType}`, python);
                }
                return codeBlock(varString, python);
            }
            function displayStringForProperty(sym, python, apiInfo) {
                const propString = `(property) ${python ? sym.pyQName : sym.qName}`;
                if (sym.retType) {
                    let retType = sym.retType;
                    if (python) {
                        retType = getPythonReturnType(retType, apiInfo);
                    }
                    return codeBlock(`${propString}: ${retType}`, false);
                }
                return codeBlock(propString, false);
            }
            function getPythonReturnType(type, apiInfo) {
                var _a;
                switch (type) {
                    case "void": return "None";
                    case "boolean": return "bool";
                    case "string": return "str";
                }
                if ((_a = apiInfo.byQName[type]) === null || _a === void 0 ? void 0 : _a.pyQName) {
                    return apiInfo.byQName[type].pyQName;
                }
                const arrayMatch = /^(?:Array<(.+)>)|(?:(.+)\[\])|(?:\[.+\])$/.exec(type);
                if (arrayMatch) {
                    return `List[${getPythonReturnType(arrayMatch[1] || arrayMatch[2], apiInfo)}]`;
                }
                return type;
            }
            function codeBlock(content, python) {
                // The stock TypeScript language service always uses js tags instead of ts. We
                // don't include the js language service in monaco, so use ts instead. It produces
                // slightly different syntax highlighting
                return `\`\`\`${python ? "python" : "ts"}\n${content}\n\`\`\``;
            }
        })(service = pxtc.service || (pxtc.service = {}));
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
/* Docs:
 *
 * Thumb 16-bit Instruction Set Quick Reference Card
 *   http://infocenter.arm.com/help/topic/com.arm.doc.qrc0006e/QRC0006_UAL16.pdf
 *
 * ARMv6-M Architecture Reference Manual (bit encoding of instructions)
 *   http://ecee.colorado.edu/ecen3000/labs/lab3/files/DDI0419C_arm_architecture_v6m_reference_manual.pdf
 *
 * The ARM-THUMB Procedure Call Standard
 *   http://www.cs.cornell.edu/courses/cs414/2001fa/armcallconvention.pdf
 *
 * Cortex-M0 Technical Reference Manual: 3.3. Instruction set summary (cycle counts)
 *   http://infocenter.arm.com/help/index.jsp?topic=/com.arm.doc.ddi0432c/CHDCICDF.html  // M0
 *   http://infocenter.arm.com/help/index.jsp?topic=/com.arm.doc.ddi0484c/CHDCICDF.html  // M0+
 */
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        var thumb;
        (function (thumb) {
            const thumbRegs = {
                "r0": 0,
                "r1": 1,
                "r2": 2,
                "r3": 3,
                "r4": 4,
                "r5": 5,
                "r6": 6,
                "r7": 7,
                "r8": 8,
                "r9": 9,
                "r10": 10,
                "r11": 10,
                "r12": 12,
                "sp": 13,
                "r13": 13,
                "lr": 14,
                "r14": 14,
                "pc": 15,
                "r15": 15,
            };
            class ThumbProcessor extends pxtc.assembler.AbstractProcessor {
                constructor() {
                    super();
                    // Registers
                    // $r0 - bits 2:1:0
                    // $r1 - bits 5:4:3
                    // $r2 - bits 7:2:1:0
                    // $r3 - bits 6:5:4:3
                    // $r4 - bits 8:7:6
                    // $r5 - bits 10:9:8
                    this.addEnc("$r0", "R0-7", v => this.inrange(7, v, v));
                    this.addEnc("$r1", "R0-7", v => this.inrange(7, v, v << 3));
                    this.addEnc("$r2", "R0-15", v => this.inrange(15, v, (v & 7) | ((v & 8) << 4)));
                    this.addEnc("$r3", "R0-15", v => this.inrange(15, v, v << 3));
                    this.addEnc("$r4", "R0-7", v => this.inrange(7, v, v << 6));
                    this.addEnc("$r5", "R0-7", v => this.inrange(7, v, v << 8));
                    // this for setting both $r0 and $r1 (two argument adds and subs)
                    this.addEnc("$r01", "R0-7", v => this.inrange(7, v, (v | v << 3)));
                    // Immdiates:
                    // $i0 - bits 7-0
                    // $i1 - bits 7-0 * 4
                    // $i2 - bits 6-0 * 4
                    // $i3 - bits 8-6
                    // $i4 - bits 10-6
                    // $i5 - bits 10-6 * 4
                    // $i6 - bits 10-6, 0 is 32
                    // $i7 - bits 10-6 * 2
                    this.addEnc("$i0", "#0-255", v => this.inrange(255, v, v));
                    this.addEnc("$i1", "#0-1020", v => this.inrange(255, v / 4, v >> 2));
                    this.addEnc("$i2", "#0-510", v => this.inrange(127, v / 4, v >> 2));
                    this.addEnc("$i3", "#0-7", v => this.inrange(7, v, v << 6));
                    this.addEnc("$i4", "#0-31", v => this.inrange(31, v, v << 6));
                    this.addEnc("$i5", "#0-124", v => this.inrange(31, v / 4, (v >> 2) << 6));
                    this.addEnc("$i6", "#1-32", v => v == 0 ? null : v == 32 ? 0 : this.inrange(31, v, v << 6));
                    this.addEnc("$i7", "#0-62", v => this.inrange(31, v / 2, (v >> 1) << 6));
                    this.addEnc("$i32", "#0-2^32", v => 1);
                    this.addEnc("$rl0", "{R0-7,...}", v => this.inrange(255, v, v));
                    this.addEnc("$rl1", "{LR,R0-7,...}", v => (v & 0x4000) ? this.inrange(255, (v & ~0x4000), 0x100 | (v & 0xff)) : this.inrange(255, v, v));
                    this.addEnc("$rl2", "{PC,R0-7,...}", v => (v & 0x8000) ? this.inrange(255, (v & ~0x8000), 0x100 | (v & 0xff)) : this.inrange(255, v, v));
                    this.addEnc("$la", "LABEL", v => this.inrange(255, v / 4, v >> 2)).isWordAligned = true;
                    this.addEnc("$lb", "LABEL", v => this.inrangeSigned(127, v / 2, v >> 1));
                    this.addEnc("$lb11", "LABEL", v => this.inrangeSigned(1023, v / 2, v >> 1));
                    //this.addInst("nop",                   0xbf00, 0xffff);  // we use mov r8,r8 as gcc
                    this.addInst("adcs  $r0, $r1", 0x4140, 0xffc0);
                    this.addInst("add   $r2, $r3", 0x4400, 0xff00);
                    this.addInst("add   $r5, pc, $i1", 0xa000, 0xf800);
                    this.addInst("add   $r5, sp, $i1", 0xa800, 0xf800);
                    this.addInst("add   sp, $i2", 0xb000, 0xff80).canBeShared = true;
                    this.addInst("adds  $r0, $r1, $i3", 0x1c00, 0xfe00);
                    this.addInst("adds  $r0, $r1, $r4", 0x1800, 0xfe00);
                    this.addInst("adds  $r01, $r4", 0x1800, 0xfe00);
                    this.addInst("adds  $r5, $i0", 0x3000, 0xf800);
                    this.addInst("adr   $r5, $la", 0xa000, 0xf800);
                    this.addInst("ands  $r0, $r1", 0x4000, 0xffc0);
                    this.addInst("asrs  $r0, $r1", 0x4100, 0xffc0);
                    this.addInst("asrs  $r0, $r1, $i6", 0x1000, 0xf800);
                    this.addInst("bics  $r0, $r1", 0x4380, 0xffc0);
                    this.addInst("bkpt  $i0", 0xbe00, 0xff00);
                    this.addInst("blx   $r3", 0x4780, 0xff87);
                    this.addInst("bx    $r3", 0x4700, 0xff80);
                    this.addInst("cmn   $r0, $r1", 0x42c0, 0xffc0);
                    this.addInst("cmp   $r0, $r1", 0x4280, 0xffc0);
                    this.addInst("cmp   $r2, $r3", 0x4500, 0xff00);
                    this.addInst("cmp   $r5, $i0", 0x2800, 0xf800);
                    this.addInst("eors  $r0, $r1", 0x4040, 0xffc0);
                    this.addInst("ldmia $r5!, $rl0", 0xc800, 0xf800);
                    this.addInst("ldmia $r5, $rl0", 0xc800, 0xf800);
                    this.addInst("ldr   $r0, [$r1, $i5]", 0x6800, 0xf800); // this is used for debugger breakpoint - cannot be shared
                    this.addInst("ldr   $r0, [$r1, $r4]", 0x5800, 0xfe00);
                    this.addInst("ldr   $r5, [pc, $i1]", 0x4800, 0xf800);
                    this.addInst("ldr   $r5, $la", 0x4800, 0xf800);
                    this.addInst("ldr   $r5, [sp, $i1]", 0x9800, 0xf800).canBeShared = true;
                    this.addInst("ldr   $r5, [sp]", 0x9800, 0xf800).canBeShared = true;
                    this.addInst("ldrb  $r0, [$r1, $i4]", 0x7800, 0xf800);
                    this.addInst("ldrb  $r0, [$r1, $r4]", 0x5c00, 0xfe00);
                    this.addInst("ldrh  $r0, [$r1, $i7]", 0x8800, 0xf800);
                    this.addInst("ldrh  $r0, [$r1, $r4]", 0x5a00, 0xfe00);
                    this.addInst("ldrsb $r0, [$r1, $r4]", 0x5600, 0xfe00);
                    this.addInst("ldrsh $r0, [$r1, $r4]", 0x5e00, 0xfe00);
                    this.addInst("lsls  $r0, $r1", 0x4080, 0xffc0);
                    this.addInst("lsls  $r0, $r1, $i4", 0x0000, 0xf800);
                    this.addInst("lsrs  $r0, $r1", 0x40c0, 0xffc0);
                    this.addInst("lsrs  $r0, $r1, $i6", 0x0800, 0xf800);
                    //this.addInst("mov   $r0, $r1", 0x4600, 0xffc0);
                    this.addInst("mov   $r2, $r3", 0x4600, 0xff00);
                    this.addInst("movs  $r0, $r1", 0x0000, 0xffc0);
                    this.addInst("movs  $r5, $i0", 0x2000, 0xf800);
                    this.addInst("muls  $r0, $r1", 0x4340, 0xffc0);
                    this.addInst("mvns  $r0, $r1", 0x43c0, 0xffc0);
                    this.addInst("negs  $r0, $r1", 0x4240, 0xffc0);
                    this.addInst("nop", 0x46c0, 0xffff); // mov r8, r8
                    this.addInst("orrs  $r0, $r1", 0x4300, 0xffc0);
                    this.addInst("pop   $rl2", 0xbc00, 0xfe00);
                    this.addInst("push  $rl1", 0xb400, 0xfe00);
                    this.addInst("rev   $r0, $r1", 0xba00, 0xffc0);
                    this.addInst("rev16 $r0, $r1", 0xba40, 0xffc0);
                    this.addInst("revsh $r0, $r1", 0xbac0, 0xffc0);
                    this.addInst("rors  $r0, $r1", 0x41c0, 0xffc0);
                    this.addInst("sbcs  $r0, $r1", 0x4180, 0xffc0);
                    this.addInst("sev", 0xbf40, 0xffff);
                    this.addInst("stm   $r5!, $rl0", 0xc000, 0xf800);
                    this.addInst("stmia $r5!, $rl0", 0xc000, 0xf800); // alias for stm
                    this.addInst("stmea $r5!, $rl0", 0xc000, 0xf800); // alias for stm
                    this.addInst("str   $r0, [$r1, $i5]", 0x6000, 0xf800).canBeShared = true;
                    this.addInst("str   $r0, [$r1]", 0x6000, 0xf800).canBeShared = true;
                    this.addInst("str   $r0, [$r1, $r4]", 0x5000, 0xfe00);
                    this.addInst("str   $r5, [sp, $i1]", 0x9000, 0xf800).canBeShared = true;
                    this.addInst("str   $r5, [sp]", 0x9000, 0xf800).canBeShared = true;
                    this.addInst("strb  $r0, [$r1, $i4]", 0x7000, 0xf800);
                    this.addInst("strb  $r0, [$r1, $r4]", 0x5400, 0xfe00);
                    this.addInst("strh  $r0, [$r1, $i7]", 0x8000, 0xf800);
                    this.addInst("strh  $r0, [$r1, $r4]", 0x5200, 0xfe00);
                    this.addInst("sub   sp, $i2", 0xb080, 0xff80);
                    this.addInst("subs  $r0, $r1, $i3", 0x1e00, 0xfe00);
                    this.addInst("subs  $r0, $r1, $r4", 0x1a00, 0xfe00);
                    this.addInst("subs  $r01, $r4", 0x1a00, 0xfe00);
                    this.addInst("subs  $r5, $i0", 0x3800, 0xf800);
                    this.addInst("svc   $i0", 0xdf00, 0xff00);
                    this.addInst("sxtb  $r0, $r1", 0xb240, 0xffc0);
                    this.addInst("sxth  $r0, $r1", 0xb200, 0xffc0);
                    this.addInst("tst   $r0, $r1", 0x4200, 0xffc0);
                    this.addInst("udf   $i0", 0xde00, 0xff00);
                    this.addInst("uxtb  $r0, $r1", 0xb2c0, 0xffc0);
                    this.addInst("uxth  $r0, $r1", 0xb280, 0xffc0);
                    this.addInst("wfe", 0xbf20, 0xffff);
                    this.addInst("wfi", 0xbf30, 0xffff);
                    this.addInst("yield", 0xbf10, 0xffff);
                    this.addInst("cpsid i", 0xb672, 0xffff);
                    this.addInst("cpsie i", 0xb662, 0xffff);
                    this.addInst("beq   $lb", 0xd000, 0xff00);
                    this.addInst("bne   $lb", 0xd100, 0xff00);
                    this.addInst("bcs   $lb", 0xd200, 0xff00);
                    this.addInst("bcc   $lb", 0xd300, 0xff00);
                    this.addInst("bmi   $lb", 0xd400, 0xff00);
                    this.addInst("bpl   $lb", 0xd500, 0xff00);
                    this.addInst("bvs   $lb", 0xd600, 0xff00);
                    this.addInst("bvc   $lb", 0xd700, 0xff00);
                    this.addInst("bhi   $lb", 0xd800, 0xff00);
                    this.addInst("bls   $lb", 0xd900, 0xff00);
                    this.addInst("bge   $lb", 0xda00, 0xff00);
                    this.addInst("blt   $lb", 0xdb00, 0xff00);
                    this.addInst("bgt   $lb", 0xdc00, 0xff00);
                    this.addInst("ble   $lb", 0xdd00, 0xff00);
                    this.addInst("bhs   $lb", 0xd200, 0xff00); // cs
                    this.addInst("blo   $lb", 0xd300, 0xff00); // cc
                    this.addInst("b     $lb11", 0xe000, 0xf800);
                    this.addInst("bal   $lb11", 0xe000, 0xf800);
                    // handled specially - 32 bit instruction
                    this.addInst("bl    $lb", 0xf000, 0xf800, true);
                    // this is normally emitted as 'b' but will be emitted as 'bl' if needed
                    this.addInst("bb    $lb", 0xe000, 0xf800, true);
                    // this will emit as PC-relative LDR or ADDS
                    this.addInst("ldlit   $r5, $i32", 0x4800, 0xf800);
                }
                toFnPtr(v, baseOff, lbl) {
                    if (pxtc.target.runtimeIsARM && /::/.test(lbl))
                        return (v + baseOff) & ~1;
                    return (v + baseOff) | 1;
                }
                wordSize() {
                    return 4;
                }
                is32bit(i) {
                    return i.name == "bl" || i.name == "bb";
                }
                postProcessAbsAddress(f, v) {
                    // Thumb addresses have last bit set, but we are ourselves always
                    // in Thumb state, so to go to ARM state, we signal that with that last bit
                    v ^= 1;
                    v -= f.baseOffset;
                    return v;
                }
                emit32(v0, v, actual) {
                    let isBLX = v % 2 ? true : false;
                    if (isBLX) {
                        v = (v + 1) & ~3;
                    }
                    let off = v >> 1;
                    pxtc.assert(off != null);
                    // Range is +-4M (i.e., 2M instructions)
                    if ((off | 0) != off ||
                        !(-2 * 1024 * 1024 < off && off < 2 * 1024 * 1024))
                        return pxtc.assembler.emitErr("jump out of range", actual);
                    // note that off is already in instructions, not bytes
                    let imm11 = off & 0x7ff;
                    let imm10 = (off >> 11) & 0x3ff;
                    return {
                        opcode: (off & 0xf0000000) ? (0xf400 | imm10) : (0xf000 | imm10),
                        opcode2: isBLX ? (0xe800 | imm11) : (0xf800 | imm11),
                        stack: 0,
                        numArgs: [v],
                        labelName: actual
                    };
                }
                expandLdlit(f) {
                    let nextGoodSpot;
                    let needsJumpOver = false;
                    let outlines = [];
                    let values = {};
                    let seq = 1;
                    for (let i = 0; i < f.lines.length; ++i) {
                        let line = f.lines[i];
                        outlines.push(line);
                        if (line.type == "instruction" && line.instruction && line.instruction.name == "ldlit") {
                            if (!nextGoodSpot) {
                                let limit = line.location + 900; // leave some space - real limit is 1020
                                let j = i + 1;
                                for (; j < f.lines.length; ++j) {
                                    if (f.lines[j].location > limit)
                                        break;
                                    let op = f.lines[j].getOp();
                                    if (op == "b" || op == "bb" || (op == "pop" && f.lines[j].words[2] == "pc"))
                                        nextGoodSpot = f.lines[j];
                                }
                                if (nextGoodSpot) {
                                    needsJumpOver = false;
                                }
                                else {
                                    needsJumpOver = true;
                                    while (--j > i) {
                                        if (f.lines[j].type == "instruction") {
                                            nextGoodSpot = f.lines[j];
                                            break;
                                        }
                                    }
                                }
                            }
                            let reg = line.words[1];
                            // make sure the key in values[] below doesn't look like integer
                            // we rely on Object.keys() returning stuff in insertion order, and integers mess with it
                            // see https://www.ecma-international.org/ecma-262/6.0/#sec-ordinary-object-internal-methods-and-internal-slots-ownpropertykeys
                            // or possibly https://www.stefanjudis.com/today-i-learned/property-order-is-predictable-in-javascript-objects-since-es2015/
                            let v = "#" + line.words[3];
                            let lbl = pxtc.U.lookup(values, v);
                            if (!lbl) {
                                lbl = "_ldlit_" + ++seq;
                                values[v] = lbl;
                            }
                            line.update(`ldr ${reg}, ${lbl}`);
                        }
                        if (line === nextGoodSpot) {
                            nextGoodSpot = null;
                            let txtLines = [];
                            let jmplbl = "_jmpwords_" + ++seq;
                            if (needsJumpOver)
                                txtLines.push("bb " + jmplbl);
                            txtLines.push(".balign 4");
                            for (let v of Object.keys(values)) {
                                let lbl = values[v];
                                txtLines.push(lbl + ": .word " + v.slice(1));
                            }
                            if (needsJumpOver)
                                txtLines.push(jmplbl + ":");
                            for (let t of txtLines) {
                                f.buildLine(t, outlines);
                                let ll = outlines[outlines.length - 1];
                                ll.scope = line.scope;
                                ll.lineNo = line.lineNo;
                            }
                            values = {};
                        }
                    }
                    f.lines = outlines;
                }
                getAddressFromLabel(f, i, s, wordAligned = false) {
                    let l = f.lookupLabel(s);
                    if (l == null)
                        return null;
                    let pc = f.location() + 4;
                    if (wordAligned)
                        pc = pc & 0xfffffffc;
                    return l - pc;
                }
                isPop(opcode) {
                    return opcode == 0xbc00;
                }
                isPush(opcode) {
                    return opcode == 0xb400;
                }
                isAddSP(opcode) {
                    return opcode == 0xb000;
                }
                isSubSP(opcode) {
                    return opcode == 0xb080;
                }
                peephole(ln, lnNext, lnNext2) {
                    let lb11 = this.encoders["$lb11"];
                    let lb = this.encoders["$lb"];
                    // +/-8 bytes is because the code size can slightly change due to .balign directives
                    // inserted by literal generation code; see https://github.com/Microsoft/pxt-adafruit/issues/514
                    // Most likely 4 would be enough, but we play it safe
                    function fits(enc, ln) {
                        return (enc.encode(ln.numArgs[0] + 8) != null &&
                            enc.encode(ln.numArgs[0] - 8) != null &&
                            enc.encode(ln.numArgs[0]) != null);
                    }
                    let lnop = ln.getOp();
                    let isSkipBranch = false;
                    if (lnop == "bne" || lnop == "beq") {
                        if (lnNext.getOp() == "b" && ln.numArgs[0] == 0)
                            isSkipBranch = true;
                        if (lnNext.getOp() == "bb" && ln.numArgs[0] == 2)
                            isSkipBranch = true;
                    }
                    if (lnop == "bb" && fits(lb11, ln)) {
                        // RULE: bb .somewhere -> b .somewhere (if fits)
                        ln.update("b " + ln.words[1]);
                    }
                    else if (lnop == "b" && ln.numArgs[0] == -2) {
                        // RULE: b .somewhere; .somewhere: -> .somewhere:
                        ln.update("");
                    }
                    else if (lnop == "bne" && isSkipBranch && fits(lb, lnNext)) {
                        // RULE: bne .next; b .somewhere; .next: -> beq .somewhere
                        ln.update("beq " + lnNext.words[1]);
                        lnNext.update("");
                    }
                    else if (lnop == "beq" && isSkipBranch && fits(lb, lnNext)) {
                        // RULE: beq .next; b .somewhere; .next: -> bne .somewhere
                        ln.update("bne " + lnNext.words[1]);
                        lnNext.update("");
                    }
                    else if (lnop == "push" && ln.numArgs[0] == 0x4000 && lnNext.getOp() == "push" && !(lnNext.numArgs[0] & 0x4000)) {
                        // RULE: push {lr}; push {X, ...} -> push {lr, X, ...}
                        ln.update(lnNext.text.replace("{", "{lr, "));
                        lnNext.update("");
                    }
                    else if (lnop == "pop" && lnNext.getOp() == "pop" && lnNext.numArgs[0] == 0x8000) {
                        // RULE: pop {X, ...}; pop {pc} -> push {X, ..., pc}
                        ln.update(ln.text.replace("}", ", pc}"));
                        lnNext.update("");
                    }
                    else if (lnop == "push" && lnNext.getOp() == "pop" && ln.numArgs[0] == lnNext.numArgs[0]) {
                        // RULE: push {X}; pop {X} -> nothing
                        pxtc.assert(ln.numArgs[0] > 0);
                        ln.update("");
                        lnNext.update("");
                    }
                    else if (lnop == "push" && lnNext.getOp() == "pop" &&
                        ln.words.length == 4 &&
                        lnNext.words.length == 4) {
                        // RULE: push {rX}; pop {rY} -> mov rY, rX
                        pxtc.assert(ln.words[1] == "{");
                        ln.update("mov " + lnNext.words[2] + ", " + ln.words[2]);
                        lnNext.update("");
                    }
                    else if (lnNext2 && ln.getOpExt() == "movs $r5, $i0" && lnNext.getOpExt() == "mov $r0, $r1" &&
                        ln.numArgs[0] == lnNext.numArgs[1] &&
                        clobbersReg(lnNext2, ln.numArgs[0])) {
                        // RULE: movs rX, #V; mov rY, rX; clobber rX -> movs rY, #V
                        ln.update("movs r" + lnNext.numArgs[0] + ", #" + ln.numArgs[1]);
                        lnNext.update("");
                    }
                    else if (lnop == "pop" && singleReg(ln) >= 0 && lnNext.getOp() == "push" &&
                        singleReg(ln) == singleReg(lnNext)) {
                        // RULE: pop {rX}; push {rX} -> ldr rX, [sp, #0]
                        ln.update("ldr r" + singleReg(ln) + ", [sp, #0]");
                        lnNext.update("");
                    }
                    else if (lnop == "push" && lnNext.getOpExt() == "ldr $r5, [sp, $i1]" &&
                        singleReg(ln) == lnNext.numArgs[0] && lnNext.numArgs[1] == 0) {
                        // RULE: push {rX}; ldr rX, [sp, #0] -> push {rX}
                        lnNext.update("");
                    }
                    else if (lnNext2 && lnop == "push" && singleReg(ln) >= 0 && preservesReg(lnNext, singleReg(ln)) &&
                        lnNext2.getOp() == "pop" && singleReg(ln) == singleReg(lnNext2)) {
                        // RULE: push {rX}; movs rY, #V; pop {rX} -> movs rY, #V (when X != Y)
                        ln.update("");
                        lnNext2.update("");
                    }
                }
                registerNo(actual) {
                    if (!actual)
                        return null;
                    actual = actual.toLowerCase();
                    const r = thumbRegs[actual];
                    if (r === undefined)
                        return null;
                    return r;
                }
                testAssembler() {
                    pxtc.assembler.expectError(this, "lsl r0, r0, #8");
                    pxtc.assembler.expectError(this, "push {pc,lr}");
                    pxtc.assembler.expectError(this, "push {r17}");
                    pxtc.assembler.expectError(this, "mov r0, r1 foo");
                    pxtc.assembler.expectError(this, "movs r14, #100");
                    pxtc.assembler.expectError(this, "push {r0");
                    pxtc.assembler.expectError(this, "push lr,r0}");
                    pxtc.assembler.expectError(this, "pop {lr,r0}");
                    pxtc.assembler.expectError(this, "b #+11");
                    pxtc.assembler.expectError(this, "b #+102400");
                    pxtc.assembler.expectError(this, "bne undefined_label");
                    pxtc.assembler.expectError(this, ".foobar");
                    pxtc.assembler.expect(this, "0200      lsls    r0, r0, #8\n" +
                        "b500      push    {lr}\n" +
                        "2064      movs    r0, #100        ; 0x64\n" +
                        "b401      push    {r0}\n" +
                        "bc08      pop     {r3}\n" +
                        "b501      push    {r0, lr}\n" +
                        "bd20      pop {r5, pc}\n" +
                        "bc01      pop {r0}\n" +
                        "4770      bx      lr\n" +
                        "0000      .balign 4\n" +
                        "e6c0      .word   -72000\n" +
                        "fffe\n");
                    pxtc.assembler.expect(this, "4291      cmp     r1, r2\n" +
                        "d100      bne     l6\n" +
                        "e000      b       l8\n" +
                        "1840  l6: adds    r0, r0, r1\n" +
                        "4718  l8: bx      r3\n");
                    pxtc.assembler.expect(this, "          @stackmark base\n" +
                        "b403      push    {r0, r1}\n" +
                        "          @stackmark locals\n" +
                        "9801      ldr     r0, [sp, locals@1]\n" +
                        "b401      push    {r0}\n" +
                        "9802      ldr     r0, [sp, locals@1]\n" +
                        "bc01      pop     {r0}\n" +
                        "          @stackempty locals\n" +
                        "9901      ldr     r1, [sp, locals@1]\n" +
                        "9102      str     r1, [sp, base@0]\n" +
                        "          @stackempty locals\n" +
                        "b002      add     sp, #8\n" +
                        "          @stackempty base\n");
                    pxtc.assembler.expect(this, "b090      sub sp, #4*16\n" +
                        "b010      add sp, #4*16\n");
                    pxtc.assembler.expect(this, "6261      .string \"abc\"\n" +
                        "0063      \n");
                    pxtc.assembler.expect(this, "6261      .string \"abcde\"\n" +
                        "6463      \n" +
                        "0065      \n");
                    pxtc.assembler.expect(this, "3042      adds r0, 0x42\n" +
                        "1c0d      adds r5, r1, #0\n" +
                        "d100      bne #0\n" +
                        "2800      cmp r0, #0\n" +
                        "6b28      ldr r0, [r5, #48]\n" +
                        "0200      lsls r0, r0, #8\n" +
                        "2063      movs r0, 0x63\n" +
                        "4240      negs r0, r0\n" +
                        "46c0      nop\n" +
                        "b500      push {lr}\n" +
                        "b401      push {r0}\n" +
                        "b402      push {r1}\n" +
                        "b404      push {r2}\n" +
                        "b408      push {r3}\n" +
                        "b520      push {r5, lr}\n" +
                        "bd00      pop {pc}\n" +
                        "bc01      pop {r0}\n" +
                        "bc02      pop {r1}\n" +
                        "bc04      pop {r2}\n" +
                        "bc08      pop {r3}\n" +
                        "bd20      pop {r5, pc}\n" +
                        "9003      str r0, [sp, #4*3]\n");
                }
            }
            thumb.ThumbProcessor = ThumbProcessor;
            // if true then instruction doesn't write r<n> and doesn't read/write memory
            function preservesReg(ln, n) {
                if (ln.getOpExt() == "movs $r5, $i0" && ln.numArgs[0] != n)
                    return true;
                return false;
            }
            function clobbersReg(ln, n) {
                // TODO add some more
                if (ln.getOp() == "pop" && ln.numArgs[0] & (1 << n))
                    return true;
                return false;
            }
            function singleReg(ln) {
                pxtc.assert(ln.getOp() == "push" || ln.getOp() == "pop");
                let k = 0;
                let ret = -1;
                let v = ln.numArgs[0];
                while (v > 0) {
                    if (v & 1) {
                        if (ret == -1)
                            ret = k;
                        else
                            ret = -2;
                    }
                    v >>= 1;
                    k++;
                }
                if (ret >= 0)
                    return ret;
                else
                    return -1;
            }
        })(thumb = pxtc.thumb || (pxtc.thumb = {}));
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
// TODO remove decr() on variable init
// TODO figure out why undefined initializer generates code
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        var ir;
        (function (ir) {
            let U = pxtc.Util;
            let assert = U.assert;
            let EK;
            (function (EK) {
                EK[EK["None"] = 0] = "None";
                EK[EK["NumberLiteral"] = 1] = "NumberLiteral";
                EK[EK["PointerLiteral"] = 2] = "PointerLiteral";
                EK[EK["RuntimeCall"] = 3] = "RuntimeCall";
                EK[EK["ProcCall"] = 4] = "ProcCall";
                EK[EK["SharedRef"] = 5] = "SharedRef";
                EK[EK["SharedDef"] = 6] = "SharedDef";
                EK[EK["FieldAccess"] = 7] = "FieldAccess";
                EK[EK["Store"] = 8] = "Store";
                EK[EK["CellRef"] = 9] = "CellRef";
                EK[EK["Sequence"] = 10] = "Sequence";
                EK[EK["JmpValue"] = 11] = "JmpValue";
                EK[EK["Nop"] = 12] = "Nop";
                EK[EK["InstanceOf"] = 13] = "InstanceOf";
            })(EK = ir.EK || (ir.EK = {}));
            let currExprId = 0;
            class Node {
                isExpr() { return false; }
                isStmt() { return false; }
                getId() {
                    if (!this._id)
                        this._id = ++currExprId;
                    return this._id;
                }
            }
            ir.Node = Node;
            class Expr extends Node {
                constructor(exprKind, args, data) {
                    super();
                    this.exprKind = exprKind;
                    this.args = args;
                    this.data = data;
                    this.callingConvention = 0 /* Plain */;
                }
                static clone(e) {
                    let copy = new Expr(e.exprKind, e.args ? e.args.slice(0) : null, e.data);
                    if (e.jsInfo)
                        copy.jsInfo = e.jsInfo;
                    if (e.totalUses) {
                        copy.totalUses = e.totalUses;
                        copy.currUses = e.currUses;
                    }
                    copy.callingConvention = e.callingConvention;
                    copy.mask = e.mask;
                    copy.isStringLiteral = e.isStringLiteral;
                    return copy;
                }
                reset() {
                    this.currUses = 0;
                    if (this.prevTotalUses)
                        this.totalUses = this.prevTotalUses;
                }
                ptrlabel() {
                    if (this.jsInfo instanceof Stmt)
                        return this.jsInfo;
                    return null;
                }
                hexlit() {
                    const anyJs = this.jsInfo;
                    if (anyJs.hexlit != null)
                        return anyJs.hexlit;
                    return null;
                }
                isExpr() { return true; }
                isPure() {
                    return this.isStateless() || this.exprKind == EK.CellRef;
                }
                isLiteral() {
                    switch (this.exprKind) {
                        case EK.NumberLiteral:
                        case EK.PointerLiteral:
                            return true;
                        default: return false;
                    }
                }
                isStateless() {
                    switch (this.exprKind) {
                        case EK.NumberLiteral:
                        case EK.PointerLiteral:
                        case EK.SharedRef:
                            return true;
                        default: return false;
                    }
                }
                sharingInfo() {
                    let arg0 = this;
                    let id = this.getId();
                    if (this.exprKind == EK.SharedRef || this.exprKind == EK.SharedDef) {
                        arg0 = this.args[0];
                        if (!arg0)
                            arg0 = { currUses: "", totalUses: "" };
                        else
                            id = arg0.getId();
                    }
                    return `${arg0.currUses}/${arg0.totalUses} #${id}`;
                }
                toString() {
                    return nodeToString(this);
                }
                canUpdateCells() {
                    switch (this.exprKind) {
                        case EK.NumberLiteral:
                        case EK.PointerLiteral:
                        case EK.CellRef:
                        case EK.JmpValue:
                        case EK.SharedRef:
                        case EK.Nop:
                            return false;
                        case EK.SharedDef:
                        case EK.FieldAccess:
                        case EK.InstanceOf:
                            return this.args[0].canUpdateCells();
                        case EK.RuntimeCall:
                        case EK.ProcCall:
                        case EK.Sequence:
                            return true;
                        case EK.Store:
                            return true;
                        default: throw pxtc.oops();
                    }
                }
            }
            ir.Expr = Expr;
            let SK;
            (function (SK) {
                SK[SK["None"] = 0] = "None";
                SK[SK["Expr"] = 1] = "Expr";
                SK[SK["Label"] = 2] = "Label";
                SK[SK["Jmp"] = 3] = "Jmp";
                SK[SK["StackEmpty"] = 4] = "StackEmpty";
                SK[SK["Breakpoint"] = 5] = "Breakpoint";
                SK[SK["Comment"] = 6] = "Comment";
            })(SK = ir.SK || (ir.SK = {}));
            let JmpMode;
            (function (JmpMode) {
                JmpMode[JmpMode["Always"] = 1] = "Always";
                JmpMode[JmpMode["IfZero"] = 2] = "IfZero";
                JmpMode[JmpMode["IfNotZero"] = 3] = "IfNotZero";
            })(JmpMode = ir.JmpMode || (ir.JmpMode = {}));
            ir.lblNumUsesJmpNext = -101;
            class Stmt extends Node {
                constructor(stmtKind, expr) {
                    super();
                    this.stmtKind = stmtKind;
                    this.expr = expr;
                }
                isStmt() { return true; }
                toString() {
                    return nodeToString(this);
                }
            }
            ir.Stmt = Stmt;
            function nodeToString(n) {
                return str(n);
                function str(n) {
                    if (n.isExpr()) {
                        let e = n;
                        let a0 = e.args ? e.args[0] : null;
                        switch (e.exprKind) {
                            case EK.NumberLiteral:
                                return e.data + "";
                            case EK.PointerLiteral:
                                return e.data + "";
                            case EK.CellRef:
                                return e.data.toString();
                            case EK.JmpValue:
                                return "JMPVALUE";
                            case EK.Nop:
                                return "NOP";
                            case EK.SharedRef:
                                return `SHARED_REF(#${a0.getId()})`;
                            case EK.SharedDef:
                                return `SHARED_DEF(#${a0.getId()} u(${a0.totalUses}): ${str(a0)})`;
                            case EK.FieldAccess:
                                return `${str(a0)}.${e.data.name}`;
                            case EK.RuntimeCall:
                                return e.data + "(" + e.args.map(str).join(", ") + ")";
                            case EK.ProcCall:
                                let procid = e.data;
                                let name = "";
                                if (procid.ifaceIndex != null)
                                    name = `IFACE@${procid.ifaceIndex}`;
                                else if (procid.virtualIndex != null)
                                    name = `VTABLE@${procid.virtualIndex}`;
                                else
                                    name = pxtc.getDeclName(procid.proc.action);
                                return name + "(" + e.args.map(str).join(", ") + ")";
                            case EK.Sequence:
                                return "(" + e.args.map(str).join("; ") + ")";
                            case EK.InstanceOf:
                                return "(" + str(e.args[0]) + " instanceof " + e.data.id + ")";
                            case EK.Store:
                                return `{ ${str(e.args[0])} := ${str(e.args[1])} }`;
                            default: throw pxtc.oops();
                        }
                    }
                    else {
                        let stmt = n;
                        let inner = stmt.expr ? str(stmt.expr) : "{null}";
                        switch (stmt.stmtKind) {
                            case ir.SK.Expr:
                                return "    " + inner + "\n";
                            case ir.SK.Jmp:
                                let fin = `goto ${stmt.lblName}\n`;
                                switch (stmt.jmpMode) {
                                    case JmpMode.Always:
                                        if (stmt.expr)
                                            return `    { JMPVALUE := ${inner} } ${fin}`;
                                        else
                                            return "    " + fin;
                                    case JmpMode.IfZero:
                                        return `    if (! ${inner}) ${fin}`;
                                    case JmpMode.IfNotZero:
                                        return `    if (${inner}) ${fin}`;
                                    default: throw pxtc.oops();
                                }
                            case ir.SK.StackEmpty:
                                return "    ;\n";
                            case ir.SK.Breakpoint:
                                return "    // brk " + (stmt.breakpointInfo.id) + "\n";
                            case ir.SK.Comment:
                                return "    // " + stmt.expr.data + "\n";
                            case ir.SK.Label:
                                return stmt.lblName + ":\n";
                            default: throw pxtc.oops();
                        }
                    }
                }
            }
            class Cell {
                constructor(index, def, info) {
                    this.index = index;
                    this.def = def;
                    this.info = info;
                    this.isarg = false;
                    this.iscap = false;
                    this._isLocal = false;
                    this._isGlobal = false;
                    this._debugType = "?";
                    this.isUserVariable = false;
                    this.bitSize = 0 /* None */;
                    if (def) {
                        if (!pxtc.isInPxtModules(def)) {
                            this.isUserVariable = true;
                        }
                        if (info) {
                            pxtc.setCellProps(this);
                        }
                    }
                }
                getName() {
                    return pxtc.getDeclName(this.def);
                }
                getDebugInfo() {
                    return {
                        name: this.getName(),
                        type: this._debugType,
                        index: this.index,
                    };
                }
                toString() {
                    let n = "";
                    if (this.def)
                        n += this.getName() || "?";
                    if (this.isarg)
                        n = "ARG " + n;
                    //if (this.isByRefLocal()) n = "BYREF " + n
                    return "[" + n + "]";
                }
                uniqueName() {
                    if (this.isarg)
                        return "arg" + this.index; // have to keep names stable for inheritance
                    return this.getName().replace(/[^\w]/g, "_") + "___" + pxtc.getNodeId(this.def);
                }
                isLocal() { return this._isLocal; }
                isGlobal() { return this._isGlobal; }
                loadCore() {
                    return op(EK.CellRef, null, this);
                }
                load() {
                    let r = this.loadCore();
                    if (pxtc.target.isNative && !pxtc.isStackMachine() && this.bitSize != 0 /* None */) {
                        if (this.bitSize == 6 /* UInt32 */)
                            return rtcall("pxt::fromUInt", [r]);
                        return rtcall("pxt::fromInt", [r]);
                    }
                    if (this.isByRefLocal())
                        return rtcall("pxtrt::ldlocRef", [r]);
                    return r;
                }
                isByRefLocal() {
                    return this.isLocal() && this.info.captured && this.info.written;
                }
                storeDirect(src) {
                    return op(EK.Store, [this.loadCore(), src]);
                }
                storeByRef(src) {
                    if (this.isByRefLocal()) {
                        return rtcall("pxtrt::stlocRef", [this.loadCore(), src]);
                    }
                    else {
                        if (pxtc.target.isNative && !pxtc.isStackMachine() && this.bitSize != 0 /* None */) {
                            let cnv = this.bitSize == 6 /* UInt32 */ ? "pxt::toUInt" : "pxt::toInt";
                            return this.storeDirect(rtcall(cnv, [src], 1));
                        }
                        return this.storeDirect(src);
                    }
                }
                get isTemporary() {
                    return false;
                }
            }
            ir.Cell = Cell;
            //Cells that represent variables that are generated by the compiler as temporaries
            //The user cannot access these cells from JS or blocks
            class UnnamedCell extends Cell {
                constructor(index, owningProc) {
                    super(index, null, null);
                    this.index = index;
                    this.owningProc = owningProc;
                    this.uid = UnnamedCell.unnamedCellCounter++;
                }
                getName() {
                    return "unnamed" + this.uid;
                }
                uniqueName() {
                    return this.getName() + "___U" + this.index;
                }
                isByRefLocal() {
                    return false;
                }
                get isTemporary() {
                    return true;
                }
            }
            UnnamedCell.unnamedCellCounter = 0;
            ir.UnnamedCell = UnnamedCell;
            // estimated cost in bytes of Thumb code to execute given expression
            function inlineWeight(e) {
                const cantInline = 1000000;
                const inner = () => {
                    if (!e.args)
                        return 0;
                    let inner = 0;
                    for (let ee of e.args)
                        inner += inlineWeight(ee);
                    if (e.mask && e.mask.conversions)
                        inner += e.mask.conversions.length * 4;
                    return inner;
                };
                switch (e.exprKind) {
                    case EK.NumberLiteral:
                        return 2;
                    case EK.PointerLiteral:
                        return 2 + 4;
                    case EK.RuntimeCall:
                        return inner() + 2 + 2 + 4;
                    case EK.CellRef:
                        return 2;
                    case EK.FieldAccess:
                        return inner() + (e.data.needsCheck ? 4 : 0) + 2;
                    case EK.ProcCall:
                    case EK.SharedRef:
                    case EK.SharedDef:
                    case EK.Store:
                    case EK.Sequence:
                    case EK.JmpValue:
                    case EK.Nop:
                    case EK.InstanceOf:
                        return cantInline;
                    /* maybe in future
                    case EK.ProcCall:
                        return inner() + 2 * e.args.length + 4 + 2
                    case EK.SharedRef:
                        return 2
                    case EK.SharedDef:
                        return inner() + 2
                    case EK.Store:
                        return inner()
                    case EK.Sequence:
                        return inner()
                    case EK.JmpValue:
                        return 0
                    case EK.Nop:
                        return 0
                    case EK.InstanceOf:
                        return inner() + 8
                        */
                    default:
                        throw U.oops();
                }
            }
            function inlineSubst(e) {
                e = Expr.clone(e);
                switch (e.exprKind) {
                    case EK.PointerLiteral:
                    case EK.NumberLiteral:
                        return e;
                    case EK.RuntimeCall:
                        for (let i = 0; i < e.args.length; ++i)
                            e.args[i] = inlineSubst(e.args[i]);
                        return e;
                    case EK.CellRef:
                        const cell = e.data;
                        if (cell.repl) {
                            cell.replUses++;
                            return cell.repl;
                        }
                        return e;
                    case EK.FieldAccess:
                        e.args[0] = inlineSubst(e.args[0]);
                        return e;
                    default:
                        throw U.oops();
                }
            }
            class Procedure extends Node {
                constructor() {
                    super(...arguments);
                    this.numArgs = 0;
                    this.info = null;
                    this.seqNo = -1;
                    this.isRoot = false;
                    this.locals = [];
                    this.captured = [];
                    this.args = [];
                    this.parent = null;
                    this.debugInfo = null;
                    this.fillDebugInfo = null;
                    this.classInfo = null;
                    this.perfCounterName = null;
                    this.perfCounterNo = 0;
                    this.body = [];
                    this.lblNo = 0;
                    this.action = null;
                    this.cachedJS = null;
                    this.usingCtx = null;
                }
                reset() {
                    this.body = [];
                    this.lblNo = 0;
                    this.locals = [];
                    this.captured = [];
                    this.args = [];
                }
                isGetter() {
                    return this.action && this.action.kind == ts.SyntaxKind.GetAccessor;
                }
                vtLabel() {
                    return this.label() + (pxtc.isStackMachine() ? "" : "_args");
                }
                label() {
                    return pxtc.getFunctionLabel(this.action);
                }
                toString() {
                    return `\nPROC ${pxtc.getDeclName(this.action)}\n${this.body.map(s => s.toString()).join("")}\n`;
                }
                emit(stmt) {
                    this.body.push(stmt);
                }
                emitExpr(expr) {
                    this.emit(stmt(SK.Expr, expr));
                }
                mkLabel(name) {
                    let lbl = stmt(SK.Label, null);
                    lbl.lblName = "." + name + "_" + this.lblNo++ + "_" + this.seqNo;
                    lbl.lbl = lbl;
                    return lbl;
                }
                emitLbl(lbl) {
                    this.emit(lbl);
                }
                emitLblDirect(lblName) {
                    let lbl = stmt(SK.Label, null);
                    lbl.lblName = lblName;
                    lbl.lbl = lbl;
                    this.emit(lbl);
                }
                getFullName() {
                    let name = pxtc.getDeclName(this.action);
                    if (this.action) {
                        let info = ts.pxtc.nodeLocationInfo(this.action);
                        name = info.fileName.replace("pxt_modules/", "") + "(" + (info.line + 1) + "," + (info.column + 1) + "): " + name;
                    }
                    return name;
                }
                getName() {
                    let text = this.action && this.action.name ? this.action.name.text : null;
                    return text || "inline";
                }
                mkLocal(def, info) {
                    let l = new Cell(this.locals.length, def, info);
                    this.locals.push(l);
                    return l;
                }
                mkLocalUnnamed() {
                    let uc = new UnnamedCell(this.locals.length, this);
                    this.locals.push(uc);
                    return uc;
                }
                localIndex(l, noargs = false) {
                    return this.captured.filter(n => n.def == l)[0] ||
                        this.locals.filter(n => n.def == l)[0] ||
                        (noargs ? null : this.args.filter(n => n.def == l)[0]);
                }
                stackEmpty() {
                    this.emit(stmt(SK.StackEmpty, null));
                }
                emitJmpZ(trg, expr) {
                    this.emitJmp(trg, expr, JmpMode.IfZero);
                }
                emitJmp(trg, expr, mode = JmpMode.Always, terminate = null) {
                    let jmp = stmt(SK.Jmp, expr);
                    jmp.jmpMode = mode;
                    if (terminate && terminate.exprKind == EK.NumberLiteral)
                        terminate = null;
                    jmp.terminateExpr = terminate;
                    if (typeof trg == "string")
                        jmp.lblName = trg;
                    else {
                        jmp.lbl = trg;
                        jmp.lblName = jmp.lbl.lblName;
                    }
                    this.emit(jmp);
                }
                inlineSelf(args) {
                    const { precomp, flattened } = flattenArgs(args, false, true);
                    U.assert(flattened.length == this.args.length);
                    this.args.map((a, i) => {
                        a.repl = flattened[i];
                        a.replUses = 0;
                    });
                    const r = inlineSubst(this.inlineBody);
                    this.args.forEach((a, i) => {
                        if (a.repl.exprKind == EK.SharedRef) {
                            if (!a.repl.args[0].prevTotalUses)
                                a.repl.args[0].prevTotalUses = a.repl.args[0].totalUses;
                            a.repl.args[0].totalUses += a.replUses - 1;
                        }
                        a.repl = null;
                        a.replUses = 0;
                    });
                    if (precomp.length) {
                        precomp.push(r);
                        return op(EK.Sequence, precomp);
                    }
                    else {
                        return r;
                    }
                }
                resolve() {
                    let iterargs = (e, f) => {
                        if (e.args)
                            for (let i = 0; i < e.args.length; ++i)
                                e.args[i] = f(e.args[i]);
                    };
                    // after this, totalUses holds the negation of the actual usage count
                    // also the first SharedRef is replaced with SharedDef
                    let refdef = (e) => {
                        switch (e.exprKind) {
                            case EK.SharedDef: throw U.oops();
                            case EK.SharedRef:
                                let arg = e.args[0];
                                if (!arg.totalUses) {
                                    arg.totalUses = -1;
                                    arg.currUses = 0;
                                    arg.irCurrUses = 0;
                                    let e2 = Expr.clone(e);
                                    e2.exprKind = EK.SharedDef;
                                    e2.args[0] = refdef(e2.args[0]);
                                    return e2;
                                }
                                else {
                                    arg.totalUses--;
                                    return e;
                                }
                        }
                        iterargs(e, refdef);
                        return e;
                    };
                    let opt = (e) => {
                        if (e.exprKind == EK.SharedRef)
                            return e;
                        iterargs(e, opt);
                        switch (e.exprKind) {
                            case EK.Sequence:
                                e.args = e.args.filter((a, i) => {
                                    if (i != e.args.length - 1 && a.isPure()) {
                                        // in the second opt() phase, we already have computed the total usage counts
                                        // if we drop some expressions, these need to be updated
                                        if (a.exprKind == EK.SharedRef && a.args[0].totalUses > 0)
                                            a.args[0].totalUses--;
                                        return false;
                                    }
                                    return true;
                                });
                                break;
                        }
                        return e;
                    };
                    let cntuses = (e) => {
                        switch (e.exprKind) {
                            case EK.SharedDef:
                                let arg = e.args[0];
                                //console.log(arg)
                                U.assert(arg.totalUses < 0, "arg.totalUses < 0");
                                U.assert(arg.currUses === 0, "arg.currUses === 0");
                                // if there is just one usage, strip the SharedDef
                                if (arg.totalUses == -1)
                                    return cntuses(arg);
                                else
                                    // now, we start counting for real
                                    arg.totalUses = 1;
                                break;
                            case EK.SharedRef:
                                U.assert(e.args[0].totalUses > 0, "e.args[0].totalUses > 0");
                                e.args[0].totalUses++;
                                return e;
                            case EK.PointerLiteral:
                                const pl = e.ptrlabel();
                                if (pl) {
                                    if (!pl.lblNumUses)
                                        pl.lblNumUses = 0;
                                    pl.lblNumUses++;
                                }
                                break;
                        }
                        iterargs(e, cntuses);
                        return e;
                    };
                    let sharedincr = (e) => {
                        //console.log("OUTSH", e.toString())
                        switch (e.exprKind) {
                            case EK.SharedDef:
                                iterargs(e, sharedincr);
                            case EK.SharedRef:
                                let arg = e.args[0];
                                U.assert(arg.totalUses > 0, "arg.totalUses > 0");
                                if (arg.totalUses == 1) {
                                    U.assert(e.exprKind == EK.SharedDef);
                                    return arg;
                                }
                                arg.irCurrUses++;
                                return e;
                            default:
                                iterargs(e, sharedincr);
                                return e;
                        }
                    };
                    this.body = this.body.filter(s => {
                        if (s.expr) {
                            //console.log("OPT", s.expr.toString())
                            s.expr = opt(refdef(s.expr));
                            //console.log("INTO", s.expr.toString())
                            if (s.stmtKind == ir.SK.Expr && s.expr.isPure())
                                return false;
                        }
                        return true;
                    });
                    let lbls = U.toDictionary(this.body.filter(s => s.stmtKind == ir.SK.Label), s => s.lblName);
                    for (let i = 0; i < this.body.length; ++i)
                        this.body[i].stmtNo = i;
                    for (let s of this.body) {
                        if (s.expr) {
                            //console.log("CNT", s.expr.toString())
                            s.expr = cntuses(s.expr);
                        }
                        switch (s.stmtKind) {
                            case ir.SK.Expr:
                                break;
                            case ir.SK.Jmp:
                                s.lbl = U.lookup(lbls, s.lblName);
                                if (!s.lbl)
                                    pxtc.oops("missing label: " + s.lblName);
                                if (!s.lbl.lblNumUses)
                                    s.lbl.lblNumUses = 1;
                                else
                                    s.lbl.lblNumUses++;
                                break;
                            case ir.SK.StackEmpty:
                            case ir.SK.Label:
                            case ir.SK.Breakpoint:
                            case ir.SK.Comment:
                                break;
                            default: pxtc.oops();
                        }
                    }
                    let allBrkp = [];
                    let prev = null;
                    let canInline = pxtc.target.debugMode ? false : true;
                    let inlineBody = null;
                    for (let s of this.body) {
                        if (s.expr) {
                            s.expr = opt(sharedincr(s.expr));
                        }
                        // mark Jump-to-next-instruction
                        if (prev && prev.lbl == s &&
                            prev.stmtKind == ir.SK.Jmp &&
                            s.stmtKind == ir.SK.Label &&
                            prev.jmpMode == ir.JmpMode.Always &&
                            s.lblNumUses == 1) {
                            s.lblNumUses = ir.lblNumUsesJmpNext;
                        }
                        prev = s;
                        if (s.stmtKind == ir.SK.Breakpoint) {
                            allBrkp[s.breakpointInfo.id] = s.breakpointInfo;
                        }
                        else if (canInline) {
                            if (s.stmtKind == ir.SK.Jmp) {
                                if (s.expr) {
                                    if (inlineBody)
                                        canInline = false;
                                    else
                                        inlineBody = s.expr;
                                }
                            }
                            else if (s.stmtKind == ir.SK.StackEmpty) {
                                // OK
                            }
                            else if (s.stmtKind == ir.SK.Label) {
                                if (s.lblNumUses != ir.lblNumUsesJmpNext)
                                    canInline = false;
                            }
                            else {
                                canInline = false;
                            }
                        }
                    }
                    if (canInline && inlineBody) {
                        const bodyCost = inlineWeight(inlineBody);
                        const callCost = 4 * this.args.length + 4 + 2;
                        const inlineBonus = pxtc.target.isNative ? 4 : 30;
                        if (bodyCost <= callCost + inlineBonus) {
                            this.inlineBody = inlineBody;
                            //pxt.log("INLINE: " + inlineWeight(inlineBody) + "/" + callCost + " - " + this.toString())
                        }
                    }
                    if (pxt.options.debug)
                        pxt.debug(this.toString());
                    let debugSucc = false;
                    if (debugSucc) {
                        let s = "BRKP: " + this.getName() + ":\n";
                        for (let i = 0; i < allBrkp.length; ++i) {
                            let b = allBrkp[i];
                            if (!b)
                                continue;
                            s += `${b.line + 1}: `;
                            let n = allBrkp[i + 1];
                            s += "\n";
                        }
                        console.log(s);
                    }
                }
            }
            ir.Procedure = Procedure;
            function iterExpr(e, f) {
                f(e);
                if (e.args)
                    for (let a of e.args)
                        iterExpr(a, f);
            }
            ir.iterExpr = iterExpr;
            function stmt(kind, expr) {
                return new Stmt(kind, expr);
            }
            ir.stmt = stmt;
            function comment(msg) {
                return stmt(SK.Comment, ptrlit(msg, msg));
            }
            ir.comment = comment;
            function op(kind, args, data) {
                return new Expr(kind, args, data);
            }
            ir.op = op;
            function numlit(v) {
                return op(EK.NumberLiteral, null, v);
            }
            ir.numlit = numlit;
            function shared(expr) {
                switch (expr.exprKind) {
                    case EK.SharedRef:
                        expr = expr.args[0];
                        break;
                    //case EK.PointerLiteral:
                    case EK.NumberLiteral:
                        return expr;
                }
                let r = op(EK.SharedRef, [expr]);
                return r;
            }
            ir.shared = shared;
            function ptrlit(lbl, jsInfo) {
                let r = op(EK.PointerLiteral, null, lbl);
                r.jsInfo = jsInfo;
                return r;
            }
            ir.ptrlit = ptrlit;
            function rtcall(name, args, mask = 0) {
                let r = op(EK.RuntimeCall, args, name);
                if (mask)
                    r.mask = { refMask: mask };
                return r;
            }
            ir.rtcall = rtcall;
            function rtcallMask(name, mask, callingConv, args) {
                if (U.startsWith(name, "@nomask@")) {
                    name = name.slice(8);
                    mask = 0;
                }
                let r = rtcall(name, args, mask);
                r.callingConvention = callingConv;
                return r;
            }
            ir.rtcallMask = rtcallMask;
            function flattenArgs(args, reorder = false, keepcomplex = false) {
                let didStateUpdate = reorder ? args.some(a => a.canUpdateCells()) : false;
                let complexArgs = [];
                for (let a of U.reversed(args)) {
                    if (a.isStateless())
                        continue;
                    if (a.exprKind == EK.CellRef && !didStateUpdate)
                        continue;
                    if (a.canUpdateCells())
                        didStateUpdate = true;
                    complexArgs.push(a);
                }
                complexArgs.reverse();
                if (pxtc.isStackMachine() && !keepcomplex)
                    complexArgs = [];
                let precomp = [];
                let flattened = args.map(a => {
                    let idx = complexArgs.indexOf(a);
                    if (idx >= 0) {
                        let sharedRef = a;
                        let sharedDef = a;
                        if (a.exprKind == EK.SharedDef) {
                            a.args[0].totalUses++;
                            sharedRef = ir.op(EK.SharedRef, [a.args[0]]);
                        }
                        else {
                            sharedRef = ir.op(EK.SharedRef, [a]);
                            sharedDef = ir.op(EK.SharedDef, [a]);
                            a.totalUses = 2;
                            a.currUses = 0;
                        }
                        precomp.push(sharedDef);
                        return sharedRef;
                    }
                    else
                        return a;
                });
                return { precomp, flattened };
            }
            ir.flattenArgs = flattenArgs;
        })(ir = pxtc.ir || (pxtc.ir = {}));
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
/// <reference path="../../localtypings/pxtarget.d.ts"/>
/// <reference path="../../localtypings/pxtpackage.d.ts"/>
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        class PxtNode {
            constructor(wave, id) {
                this.wave = wave;
                this.id = id;
                this.flags = 0 /* None */;
                this.resetAll();
            }
            refresh() {
                // clear IsUsed flag
                this.flags &= ~8 /* IsUsed */;
                // this happens for top-level function expression - we just re-emit them
                if (this.proc && !this.usedActions && !getEnclosingFunction(this.proc.action))
                    this.resetEmit();
                else if (this.proc && !this.proc.cachedJS)
                    this.resetEmit();
                else if (this.usedNodes)
                    this.flags |= 32 /* FromPreviousCompile */;
                if (this.classInfo)
                    this.classInfo.reset();
            }
            resetEmit() {
                // clear IsUsed flag
                this.flags &= ~(8 /* IsUsed */ | 32 /* FromPreviousCompile */);
                if (this.proc && this.proc.classInfo && this.proc.classInfo.ctor == this.proc)
                    this.proc.classInfo.ctor = null;
                this.functionInfo = null;
                this.variableInfo = null;
                this.classInfo = null;
                this.callInfo = null;
                this.proc = null;
                this.cell = null;
                this.exprInfo = null;
                this.usedNodes = null;
                this.usedActions = null;
            }
            resetTSC() {
                // clear all flags except for InPxtModules
                this.flags &= 16 /* InPxtModules */;
                this.typeCache = null;
                this.symbolCache = null;
                this.commentAttrs = null;
                this.valueOverride = null;
                this.declCache = undefined;
                this.fullName = null;
                this.constantFolded = undefined;
            }
            resetAll() {
                this.resetTSC();
                this.resetEmit();
            }
        }
        pxtc.PxtNode = PxtNode;
        let HasLiteralType;
        (function (HasLiteralType) {
            HasLiteralType[HasLiteralType["Enum"] = 0] = "Enum";
            HasLiteralType[HasLiteralType["Number"] = 1] = "Number";
            HasLiteralType[HasLiteralType["String"] = 2] = "String";
            HasLiteralType[HasLiteralType["Boolean"] = 3] = "Boolean";
            HasLiteralType[HasLiteralType["Unsupported"] = 4] = "Unsupported";
        })(HasLiteralType || (HasLiteralType = {}));
        // in tagged mode,
        // * the lowest bit set means 31 bit signed integer
        // * the lowest bit clear, and second lowest set means special constant
        // "undefined" is represented by 0
        function taggedSpecialValue(n) { return (n << 2) | 2; }
        pxtc.taggedUndefined = 0;
        pxtc.taggedNull = taggedSpecialValue(1);
        pxtc.taggedFalse = taggedSpecialValue(2);
        pxtc.taggedNaN = taggedSpecialValue(3);
        pxtc.taggedTrue = taggedSpecialValue(16);
        function fitsTaggedInt(vn) {
            if (pxtc.target.switches.boxDebug)
                return false;
            return (vn | 0) == vn && -1073741824 <= vn && vn <= 1073741823;
        }
        pxtc.thumbArithmeticInstr = {
            "adds": true,
            "subs": true,
            "muls": true,
            "ands": true,
            "orrs": true,
            "eors": true,
            "lsls": true,
            "asrs": true,
            "lsrs": true,
        };
        pxtc.numberArithmeticInstr = {
            "div": true,
            "mod": true,
            "le": true,
            "lt": true,
            "ge": true,
            "gt": true,
            "eq": true,
            "neq": true,
        };
        const thumbFuns = {
            "Array_::getAt": {
                name: "_pxt_array_get",
                argsFmt: ["T", "T", "T"],
                value: 0
            },
            "Array_::setAt": {
                name: "_pxt_array_set",
                argsFmt: ["T", "T", "T", "T"],
                value: 0
            },
            "BufferMethods::getByte": {
                name: "_pxt_buffer_get",
                argsFmt: ["T", "T", "T"],
                value: 0
            },
            "BufferMethods::setByte": {
                name: "_pxt_buffer_set",
                argsFmt: ["T", "T", "T", "I"],
                value: 0
            },
            "pxtrt::mapGetGeneric": {
                name: "_pxt_map_get",
                argsFmt: ["T", "T", "S"],
                value: 0
            },
            "pxtrt::mapSetGeneric": {
                name: "_pxt_map_set",
                argsFmt: ["T", "T", "S", "T"],
                value: 0
            },
        };
        let EK = pxtc.ir.EK;
        pxtc.SK = ts.SyntaxKind;
        pxtc.numReservedGlobals = 1;
        let lastNodeId = 0;
        let currNodeWave = 1;
        function isInPxtModules(node) {
            if (node.pxt)
                return !!(node.pxt.flags & 16 /* InPxtModules */);
            const src = ts.getSourceFileOfNode(node);
            return src ? pxtc.isPxtModulesFilename(src.fileName) : false;
        }
        pxtc.isInPxtModules = isInPxtModules;
        function pxtInfo(n) {
            if (!n.pxt) {
                const info = new PxtNode(currNodeWave, ++lastNodeId);
                if (isInPxtModules(n))
                    info.flags |= 16 /* InPxtModules */;
                n.pxt = info;
                return info;
            }
            else {
                const info = n.pxt;
                if (info.wave != currNodeWave) {
                    info.wave = currNodeWave;
                    if (!pxtc.compileOptions || !pxtc.compileOptions.skipPxtModulesTSC)
                        info.resetAll();
                    else {
                        if (info.flags & 16 /* InPxtModules */) {
                            if (pxtc.compileOptions.skipPxtModulesEmit)
                                info.refresh();
                            else
                                info.resetEmit();
                        }
                        else
                            info.resetAll();
                    }
                }
                return info;
            }
        }
        pxtc.pxtInfo = pxtInfo;
        function getNodeId(n) {
            return pxtInfo(n).id;
        }
        pxtc.getNodeId = getNodeId;
        function stringKind(n) {
            if (!n)
                return "<null>";
            return ts.SyntaxKind[n.kind];
        }
        pxtc.stringKind = stringKind;
        function inspect(n) {
            console.log(stringKind(n));
        }
        // next free error 9283
        function userError(code, msg, secondary = false) {
            let e = new Error(msg);
            e.ksEmitterUserError = true;
            e.ksErrorCode = code;
            if (secondary && inCatchErrors) {
                if (!lastSecondaryError) {
                    lastSecondaryError = msg;
                    lastSecondaryErrorCode = code;
                }
                return e;
            }
            throw e;
        }
        function isStackMachine() {
            return pxtc.target.isNative && pxtc.target.nativeType == pxtc.NATIVE_TYPE_VM;
        }
        pxtc.isStackMachine = isStackMachine;
        function needsNumberConversions() {
            return pxtc.target.isNative && pxtc.target.nativeType != pxtc.NATIVE_TYPE_VM;
        }
        pxtc.needsNumberConversions = needsNumberConversions;
        function isThumb() {
            return pxtc.target.isNative && (pxtc.target.nativeType == pxtc.NATIVE_TYPE_THUMB);
        }
        pxtc.isThumb = isThumb;
        function isThisType(type) {
            // Internal TS field
            return type.isThisType;
        }
        function isSyntheticThis(def) {
            if (def.isThisParameter)
                return true;
            else
                return false;
        }
        // everything in numops:: operates on and returns tagged ints
        // everything else (except as indicated with CommentAttrs), operates and returns regular ints
        function fromInt(e) {
            if (!needsNumberConversions())
                return e;
            return pxtc.ir.rtcall("pxt::fromInt", [e]);
        }
        function fromBool(e) {
            if (!needsNumberConversions())
                return e;
            return pxtc.ir.rtcall("pxt::fromBool", [e]);
        }
        function fromFloat(e) {
            if (!needsNumberConversions())
                return e;
            return pxtc.ir.rtcall("pxt::fromFloat", [e]);
        }
        function fromDouble(e) {
            if (!needsNumberConversions())
                return e;
            return pxtc.ir.rtcall("pxt::fromDouble", [e]);
        }
        function getBitSize(decl) {
            if (!decl || !decl.type)
                return 0 /* None */;
            if (!(isNumberType(typeOf(decl))))
                return 0 /* None */;
            if (decl.type.kind != pxtc.SK.TypeReference)
                return 0 /* None */;
            switch (decl.type.typeName.getText()) {
                case "int8": return 1 /* Int8 */;
                case "int16": return 3 /* Int16 */;
                case "int32": return 5 /* Int32 */;
                case "uint8": return 2 /* UInt8 */;
                case "uint16": return 4 /* UInt16 */;
                case "uint32": return 6 /* UInt32 */;
                default: return 0 /* None */;
            }
        }
        function sizeOfBitSize(b) {
            switch (b) {
                case 0 /* None */: return pxtc.target.shortPointers ? 2 : 4;
                case 1 /* Int8 */: return 1;
                case 3 /* Int16 */: return 2;
                case 5 /* Int32 */: return 4;
                case 2 /* UInt8 */: return 1;
                case 4 /* UInt16 */: return 2;
                case 6 /* UInt32 */: return 4;
                default: throw pxtc.oops();
            }
        }
        pxtc.sizeOfBitSize = sizeOfBitSize;
        function isBitSizeSigned(b) {
            switch (b) {
                case 1 /* Int8 */:
                case 3 /* Int16 */:
                case 5 /* Int32 */:
                    return true;
                case 2 /* UInt8 */:
                case 4 /* UInt16 */:
                case 6 /* UInt32 */:
                    return false;
                default: throw pxtc.oops();
            }
        }
        pxtc.isBitSizeSigned = isBitSizeSigned;
        function setCellProps(l) {
            l._isLocal = isLocalVar(l.def) || isParameter(l.def);
            l._isGlobal = isGlobalVar(l.def);
            if (!isSyntheticThis(l.def)) {
                let tp = typeOf(l.def);
                if (tp.flags & ts.TypeFlags.Void) {
                    pxtc.oops("void-typed variable, " + l.toString());
                }
                l.bitSize = getBitSize(l.def);
                if (l.bitSize != 0 /* None */) {
                    l._debugType = (isBitSizeSigned(l.bitSize) ? "int" : "uint") + (8 * sizeOfBitSize(l.bitSize));
                }
                else if (isStringType(tp)) {
                    l._debugType = "string";
                }
                else if (tp.flags & ts.TypeFlags.NumberLike) {
                    l._debugType = "number";
                }
            }
            if (l.isLocal() && l.bitSize != 0 /* None */) {
                l.bitSize = 0 /* None */;
                userError(9256, lf("bit sizes are not supported for locals and parameters"));
            }
        }
        pxtc.setCellProps = setCellProps;
        function isStringLiteral(node) {
            switch (node.kind) {
                case pxtc.SK.TemplateHead:
                case pxtc.SK.TemplateMiddle:
                case pxtc.SK.TemplateTail:
                case pxtc.SK.StringLiteral:
                case pxtc.SK.NoSubstitutionTemplateLiteral:
                    return true;
                default: return false;
            }
        }
        function isEmptyStringLiteral(e) {
            return isStringLiteral(e) && e.text == "";
        }
        function isStatic(node) {
            return node && node.modifiers && node.modifiers.some(m => m.kind == pxtc.SK.StaticKeyword);
        }
        pxtc.isStatic = isStatic;
        function isReadOnly(node) {
            return node.modifiers && node.modifiers.some(m => m.kind == pxtc.SK.ReadonlyKeyword);
        }
        pxtc.isReadOnly = isReadOnly;
        function getExplicitDefault(attrs, name) {
            if (!attrs.explicitDefaults)
                return null;
            if (attrs.explicitDefaults.indexOf(name) < 0)
                return null;
            return attrs.paramDefl[name];
        }
        pxtc.getExplicitDefault = getExplicitDefault;
        function classFunctionPref(node) {
            if (!node)
                return null;
            switch (node.kind) {
                case pxtc.SK.MethodDeclaration: return "";
                case pxtc.SK.Constructor: return "new/";
                case pxtc.SK.GetAccessor: return "get/";
                case pxtc.SK.SetAccessor: return "set/";
                default:
                    return null;
            }
        }
        function classFunctionKey(node) {
            return classFunctionPref(node) + getName(node);
        }
        function isClassFunction(node) {
            return classFunctionPref(node) != null;
        }
        function getEnclosingMethod(node) {
            if (!node)
                return null;
            if (isClassFunction(node))
                return node;
            return getEnclosingMethod(node.parent);
        }
        function getEnclosingFunction(node0) {
            let node = node0;
            let hadLoop = false;
            while (true) {
                node = node.parent;
                if (!node)
                    userError(9229, lf("cannot determine parent of {0}", stringKind(node0)));
                switch (node.kind) {
                    case pxtc.SK.MethodDeclaration:
                    case pxtc.SK.Constructor:
                    case pxtc.SK.GetAccessor:
                    case pxtc.SK.SetAccessor:
                    case pxtc.SK.FunctionDeclaration:
                    case pxtc.SK.ArrowFunction:
                    case pxtc.SK.FunctionExpression:
                        return node;
                    case pxtc.SK.WhileStatement:
                    case pxtc.SK.DoStatement:
                    case pxtc.SK.ForInStatement:
                    case pxtc.SK.ForOfStatement:
                    case pxtc.SK.ForStatement:
                        hadLoop = true;
                        break;
                    case pxtc.SK.SourceFile:
                        // don't treat variables declared inside of top-level loops as global
                        if (hadLoop)
                            return _rootFunction;
                        return null;
                }
            }
        }
        function isObjectType(t) {
            return "objectFlags" in t;
        }
        pxtc.isObjectType = isObjectType;
        function isVar(d) {
            if (!d)
                return false;
            if (d.kind == pxtc.SK.VariableDeclaration)
                return true;
            if (d.kind == pxtc.SK.BindingElement)
                return isVar(d.parent.parent);
            return false;
        }
        function isGlobalVar(d) {
            if (!d)
                return false;
            return (isVar(d) && !getEnclosingFunction(d)) ||
                (d.kind == pxtc.SK.PropertyDeclaration && isStatic(d));
        }
        function isLocalVar(d) {
            return isVar(d) && !isGlobalVar(d);
        }
        function isParameter(d) {
            if (!d)
                return false;
            if (d.kind == pxtc.SK.Parameter)
                return true;
            if (d.kind == pxtc.SK.BindingElement)
                return isParameter(d.parent.parent);
            return false;
        }
        function isTopLevelFunctionDecl(decl) {
            return (decl.kind == pxtc.SK.FunctionDeclaration && !getEnclosingFunction(decl)) ||
                isClassFunction(decl);
        }
        function getRefTagToValidate(tp) {
            switch (tp) {
                case "_Buffer": return pxt.BuiltInType.BoxedBuffer;
                case "_Image": return pxtc.target.imageRefTag || pxt.BuiltInType.RefImage;
                case "_Action": return pxt.BuiltInType.RefAction;
                case "_RefCollection": return pxt.BuiltInType.RefCollection;
                default:
                    return null;
            }
        }
        class ClassInfo {
            constructor(id, decl) {
                this.id = id;
                this.decl = decl;
                this.baseClassInfo = null;
                this.allfields = [];
                // indexed by getName(node)
                this.methods = {};
                this.attrs = parseComments(decl);
                this.reset();
            }
            reset() {
                this.vtable = null;
                this.itable = null;
            }
            get isUsed() {
                return !!(pxtInfo(this.decl).flags & 8 /* IsUsed */);
            }
            allMethods() {
                const r = [];
                for (let k of Object.keys(this.methods))
                    for (let m of this.methods[k]) {
                        r.push(m);
                    }
                return r;
            }
            usedMethods() {
                const r = [];
                for (let k of Object.keys(this.methods))
                    for (let m of this.methods[k]) {
                        const info = pxtInfo(m);
                        if (info.flags & 8 /* IsUsed */)
                            r.push(m);
                    }
                return r;
            }
        }
        pxtc.ClassInfo = ClassInfo;
        let lf = pxtc.assembler.lf;
        let checker;
        let _rootFunction;
        let lastSecondaryError;
        let lastSecondaryErrorCode = 0;
        let inCatchErrors = 0;
        function getNodeFullName(checker, node) {
            const pinfo = pxtInfo(node);
            if (pinfo.fullName == null)
                pinfo.fullName = pxtc.getFullName(checker, node.symbol);
            return pinfo.fullName;
        }
        pxtc.getNodeFullName = getNodeFullName;
        function getComments(node) {
            if (node.kind == pxtc.SK.VariableDeclaration)
                node = node.parent.parent; // we need variable stmt
            let cmtCore = (node) => {
                const src = ts.getSourceFileOfNode(node);
                if (!src)
                    return "";
                const doc = ts.getLeadingCommentRangesOfNode(node, src);
                if (!doc)
                    return "";
                const cmt = doc.map(r => src.text.slice(r.pos, r.end)).join("\n");
                return cmt;
            };
            if (node.symbol && node.symbol.declarations && node.symbol.declarations.length > 1) {
                return node.symbol.declarations.map(cmtCore).join("\n");
            }
            else {
                return cmtCore(node);
            }
        }
        pxtc.getComments = getComments;
        function parseCommentsOnSymbol(symbol) {
            let cmts = "";
            for (let decl of symbol.declarations) {
                cmts += getComments(decl);
            }
            return pxtc.parseCommentString(cmts);
        }
        pxtc.parseCommentsOnSymbol = parseCommentsOnSymbol;
        function parseComments(node) {
            const pinfo = node ? pxtInfo(node) : null;
            if (!pinfo || pinfo.flags & 2 /* IsBogusFunction */)
                return pxtc.parseCommentString("");
            if (pinfo.commentAttrs)
                return pinfo.commentAttrs;
            let res = pxtc.parseCommentString(getComments(node));
            res._name = getName(node);
            pinfo.commentAttrs = res;
            return res;
        }
        pxtc.parseComments = parseComments;
        function getName(node) {
            if (!node.name || node.name.kind != pxtc.SK.Identifier)
                return "???";
            return node.name.text;
        }
        pxtc.getName = getName;
        function genericRoot(t) {
            if (isObjectType(t) && t.objectFlags & ts.ObjectFlags.Reference) {
                let r = t;
                if (r.typeArguments && r.typeArguments.length)
                    return r.target;
            }
            return null;
        }
        function isArrayType(t) {
            if (!isObjectType(t)) {
                return false;
            }
            return (t.objectFlags & ts.ObjectFlags.Reference) && t.symbol && t.symbol.name == "Array";
        }
        function isInterfaceType(t) {
            if (!isObjectType(t)) {
                return false;
            }
            return !!(t.objectFlags & ts.ObjectFlags.Interface) || !!(t.objectFlags & ts.ObjectFlags.Anonymous);
        }
        function isClassType(t) {
            if (isThisType(t)) {
                return true;
            }
            if (!isObjectType(t)) {
                return false;
            }
            // check if we like the class?
            return !!((t.objectFlags & ts.ObjectFlags.Class) || (t.symbol && (t.symbol.flags & ts.SymbolFlags.Class)));
        }
        function isObjectLiteral(t) {
            return t.symbol && (t.symbol.flags & (ts.SymbolFlags.ObjectLiteral | ts.SymbolFlags.TypeLiteral)) !== 0;
        }
        function isStructureType(t) {
            return (isFunctionType(t) == null) && (isClassType(t) || isInterfaceType(t) || isObjectLiteral(t));
        }
        function castableToStructureType(t) {
            return isStructureType(t) || (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Any));
        }
        function isPossiblyGenericClassType(t) {
            let g = genericRoot(t);
            if (g)
                return isClassType(g);
            return isClassType(t);
        }
        function arrayElementType(t, idx = -1) {
            if (isArrayType(t))
                return checkType(t.typeArguments[0]);
            return checker.getIndexTypeOfType(t, ts.IndexKind.Number);
        }
        function isFunctionType(t) {
            // if an object type represents a function (via 1 signature) then it
            // can't have any other properties or constructor signatures
            if (t.getApparentProperties().length > 0 || t.getConstructSignatures().length > 0)
                return null;
            let sigs = checker.getSignaturesOfType(t, ts.SignatureKind.Call);
            if (sigs && sigs.length == 1)
                return sigs[0];
            // TODO: error message for overloaded function signatures?
            return null;
        }
        function isGenericType(t) {
            const g = genericRoot(t);
            return !!(g && g.typeParameters && g.typeParameters.length);
        }
        function checkType(t) {
            // we currently don't enforce any restrictions on type system
            return t;
        }
        pxtc.checkType = checkType;
        function taggedSpecial(v) {
            if (v === null)
                return pxtc.taggedNull;
            else if (v === undefined)
                return pxtc.taggedUndefined;
            else if (v === false)
                return pxtc.taggedFalse;
            else if (v === true)
                return pxtc.taggedTrue;
            else if (isNaN(v))
                return pxtc.taggedNaN;
            else
                return null;
        }
        pxtc.taggedSpecial = taggedSpecial;
        function typeOf(node) {
            let r;
            const info = pxtInfo(node);
            if (info.typeCache)
                return info.typeCache;
            if (ts.isExpression(node))
                r = checker.getContextualType(node);
            if (!r) {
                try {
                    r = checker.getTypeAtLocation(node);
                }
                catch (e) {
                    userError(9203, lf("Unknown type for expression"));
                }
            }
            if (!r)
                return r;
            // save for future use; this cuts around 10% of emit() time
            info.typeCache = r;
            return checkType(r);
        }
        function checkUnionOfLiterals(t) {
            if (!(t.flags & ts.TypeFlags.Union)) {
                return HasLiteralType.Unsupported;
            }
            let u = t;
            let allGood = true;
            let constituentType;
            u.types.forEach(tp => {
                if (constituentType === undefined) {
                    if (tp.flags & ts.TypeFlags.NumberLike)
                        constituentType = HasLiteralType.Number;
                    else if (tp.flags & ts.TypeFlags.BooleanLike)
                        constituentType = HasLiteralType.Boolean;
                    else if (tp.flags & ts.TypeFlags.StringLike)
                        constituentType = HasLiteralType.String;
                    else if (tp.flags & ts.TypeFlags.EnumLike)
                        constituentType = HasLiteralType.Enum;
                }
                else {
                    switch (constituentType) {
                        case HasLiteralType.Number:
                            allGood = allGood && !!(tp.flags & ts.TypeFlags.NumberLike);
                            break;
                        case HasLiteralType.Boolean:
                            allGood = allGood && !!(tp.flags & ts.TypeFlags.BooleanLike);
                            break;
                        case HasLiteralType.String:
                            allGood = allGood && !!(tp.flags & ts.TypeFlags.StringLike);
                            break;
                        case HasLiteralType.Enum:
                            allGood = allGood && !!(tp.flags & ts.TypeFlags.EnumLike);
                            break;
                    }
                }
            });
            return allGood ? constituentType : HasLiteralType.Unsupported;
        }
        function isUnionOfLiterals(t) {
            return checkUnionOfLiterals(t) !== HasLiteralType.Unsupported;
        }
        // does src inherit from tgt via heritage clauses?
        function inheritsFrom(src, tgt) {
            if (src == tgt)
                return true;
            if (src.heritageClauses)
                for (let h of src.heritageClauses) {
                    switch (h.token) {
                        case pxtc.SK.ExtendsKeyword:
                            let tp = typeOf(h.types[0]);
                            if (isClassType(tp)) {
                                let parent = tp.symbol.valueDeclaration;
                                return inheritsFrom(parent, tgt);
                            }
                    }
                }
            return false;
        }
        function checkInterfaceDeclaration(bin, decl) {
            const check = (d) => {
                if (d && d.kind == pxtc.SK.ClassDeclaration)
                    userError(9261, lf("Interface with same name as a class not supported"));
            };
            check(decl.symbol.valueDeclaration);
            if (decl.symbol.declarations)
                decl.symbol.declarations.forEach(check);
            if (decl.heritageClauses)
                for (let h of decl.heritageClauses) {
                    switch (h.token) {
                        case pxtc.SK.ExtendsKeyword:
                            let tp = typeOf(h.types[0]);
                            if (isClassType(tp)) {
                                userError(9262, lf("Extending a class by an interface not supported."));
                            }
                    }
                }
        }
        function typeCheckSubtoSup(sub, sup) {
            // we leave this function for now, in case we want to enforce some checks in future
        }
        function isGenericFunction(fun) {
            return getTypeParameters(fun).length > 0;
        }
        function getTypeParameters(fun) {
            // TODO add check for methods of generic classes
            if (fun.typeParameters && fun.typeParameters.length)
                return fun.typeParameters;
            if (isClassFunction(fun) || fun.kind == pxtc.SK.MethodSignature) {
                if (fun.parent.kind == pxtc.SK.ClassDeclaration || fun.parent.kind == pxtc.SK.InterfaceDeclaration) {
                    return fun.parent.typeParameters || [];
                }
            }
            return [];
        }
        function funcHasReturn(fun) {
            let sig = checker.getSignatureFromDeclaration(fun);
            let rettp = checker.getReturnTypeOfSignature(sig);
            return !(rettp.flags & ts.TypeFlags.Void);
        }
        function isNamedDeclaration(node) {
            return !!(node && node.name);
        }
        function parentPrefix(node) {
            if (!node)
                return "";
            switch (node.kind) {
                case pxtc.SK.ModuleBlock:
                    return parentPrefix(node.parent);
                case pxtc.SK.ClassDeclaration:
                case pxtc.SK.ModuleDeclaration:
                    return parentPrefix(node.parent) + node.name.text + ".";
                default:
                    return "";
            }
        }
        function getDeclName(node) {
            let text = isNamedDeclaration(node) ? node.name.text : null;
            if (!text) {
                if (node.kind == pxtc.SK.Constructor) {
                    text = "constructor";
                }
                else {
                    for (let parent = node.parent; parent; parent = parent.parent) {
                        if (isNamedDeclaration(parent))
                            return getDeclName(parent) + ".inline";
                    }
                    return "inline";
                }
            }
            return parentPrefix(node.parent) + text;
        }
        pxtc.getDeclName = getDeclName;
        function safeName(node) {
            let text = getDeclName(node);
            return text.replace(/[^\w]+/g, "_");
        }
        function getFunctionLabel(node) {
            return safeName(node) + "__P" + getNodeId(node);
        }
        pxtc.getFunctionLabel = getFunctionLabel;
        class FunctionAddInfo {
            constructor(decl) {
                this.decl = decl;
                this.capturedVars = [];
            }
            get isUsed() {
                return !!(pxtInfo(this.decl).flags & 8 /* IsUsed */);
            }
        }
        pxtc.FunctionAddInfo = FunctionAddInfo;
        function compileBinary(program, opts, res, entryPoint) {
            if (pxtc.compilerHooks.preBinary)
                pxtc.compilerHooks.preBinary(program, opts, res);
            pxtc.target = opts.target;
            pxtc.compileOptions = opts;
            pxtc.target.debugMode = !!opts.breakpoints;
            const diagnostics = ts.createDiagnosticCollection();
            checker = program.getTypeChecker();
            let startTime = pxtc.U.cpuUs();
            let usedWorkList = [];
            let irCachesToClear = [];
            let autoCreateFunctions = {}; // INCTODO
            let configEntries = {};
            let currJres = null;
            let currUsingContext = null;
            let needsUsingInfo = false;
            let pendingFunctionDefinitions = [];
            currNodeWave++;
            if (opts.target.isNative) {
                if (!opts.extinfo || !opts.extinfo.hexinfo) {
                    // we may have not been able to compile or download the hex file
                    return {
                        diagnostics: [{
                                file: program.getSourceFiles()[0],
                                start: 0,
                                length: 0,
                                category: pxtc.DiagnosticCategory.Error,
                                code: 9043,
                                messageText: lf("The hex file is not available, please connect to internet and try again.")
                            }],
                        emittedFiles: [],
                        emitSkipped: true
                    };
                }
                let extinfo = opts.extinfo;
                let optstarget = opts.target;
                // if current (main) extinfo is disabled use another one
                if (extinfo && extinfo.disabledDeps) {
                    const enabled = (opts.otherMultiVariants || []).find(e => e.extinfo && !e.extinfo.disabledDeps);
                    if (enabled) {
                        pxt.debug(`using alternative extinfo (due to ${extinfo.disabledDeps})`);
                        extinfo = enabled.extinfo;
                        optstarget = enabled.target;
                    }
                }
                pxtc.hexfile.setupFor(optstarget, extinfo || pxtc.emptyExtInfo());
                pxtc.hexfile.setupInlineAssembly(opts);
            }
            let bin = new Binary();
            let proc;
            bin.res = res;
            bin.options = opts;
            bin.target = opts.target;
            function reset() {
                bin.reset();
                proc = null;
                res.breakpoints = [{
                        id: 0,
                        isDebuggerStmt: false,
                        fileName: "bogus",
                        start: 0,
                        length: 0,
                        line: 0,
                        column: 0,
                    }];
                res.procCallLocations = [];
            }
            if (opts.computeUsedSymbols) {
                res.usedSymbols = {};
                res.usedArguments = {};
            }
            let allStmts = [];
            if (!opts.forceEmit || res.diagnostics.length == 0) {
                let files = program.getSourceFiles().slice();
                const main = files.find(sf => sf.fileName === pxt.MAIN_TS);
                if (main) {
                    files = files.filter(sf => sf.fileName !== pxt.MAIN_TS);
                    files.push(main);
                }
                // run post-processing code last, if present
                const postProcessing = files.find(sf => sf.fileName === pxt.TUTORIAL_CODE_STOP);
                if (postProcessing) {
                    files = files.filter(sf => sf.fileName !== pxt.TUTORIAL_CODE_STOP);
                    files.push(postProcessing);
                }
                files.forEach(f => {
                    f.statements.forEach(s => {
                        allStmts.push(s);
                    });
                });
            }
            let mainSrcFile = program.getSourceFiles().filter(f => pxtc.Util.endsWith(f.fileName, entryPoint))[0];
            let rootFunction = {
                kind: pxtc.SK.FunctionDeclaration,
                parameters: [],
                name: {
                    text: "<main>",
                    pos: 0,
                    end: 0
                },
                body: {
                    kind: pxtc.SK.Block,
                    statements: allStmts
                },
                parent: mainSrcFile,
                pos: 0,
                end: 0,
            };
            _rootFunction = rootFunction;
            const pinfo = pxtInfo(rootFunction);
            pinfo.flags |= 1 /* IsRootFunction */ | 2 /* IsBogusFunction */;
            markUsed(rootFunction);
            usedWorkList = [];
            reset();
            needsUsingInfo = true;
            emitTopLevel(rootFunction);
            for (;;) {
                flushWorkQueue();
                if (fixpointVTables())
                    break;
            }
            layOutGlobals();
            needsUsingInfo = false;
            emitVTables();
            let pass0 = pxtc.U.cpuUs();
            res.times["pass0"] = pass0 - startTime;
            let resDiags = diagnostics.getDiagnostics();
            reset();
            needsUsingInfo = false;
            bin.finalPass = true;
            emit(rootFunction);
            pxtc.U.assert(usedWorkList.length == 0);
            res.configData = [];
            for (let k of Object.keys(configEntries)) {
                if (configEntries["!" + k])
                    continue;
                res.configData.push({
                    name: k.replace(/^\!/, ""),
                    key: configEntries[k].key,
                    value: configEntries[k].value
                });
            }
            res.configData.sort((a, b) => a.key - b.key);
            let pass1 = pxtc.U.cpuUs();
            res.times["pass1"] = pass1 - pass0;
            catchErrors(rootFunction, finalEmit);
            res.times["passFinal"] = pxtc.U.cpuUs() - pass1;
            if (opts.ast) {
                let pre = pxtc.U.cpuUs();
                pxtc.annotate(program, entryPoint, pxtc.target);
                res.times["passAnnotate"] = pxtc.U.cpuUs() - pre;
            }
            // 12k for decent arcade game
            // res.times["numnodes"] = lastNodeId
            pxtc.compileOptions = null;
            if (resDiags.length == 0)
                resDiags = diagnostics.getDiagnostics();
            if (pxtc.compilerHooks.postBinary)
                pxtc.compilerHooks.postBinary(program, opts, res);
            return {
                diagnostics: resDiags,
                emittedFiles: undefined,
                emitSkipped: !!opts.noEmit
            };
            function diag(category, node, code, message, arg0, arg1, arg2) {
                diagnostics.add(ts.createDiagnosticForNode(node, {
                    code,
                    message,
                    key: message.replace(/^[a-zA-Z]+/g, "_"),
                    category,
                }, arg0, arg1, arg2));
            }
            function warning(node, code, msg, arg0, arg1, arg2) {
                diag(pxtc.DiagnosticCategory.Warning, node, code, msg, arg0, arg1, arg2);
            }
            function error(node, code, msg, arg0, arg1, arg2) {
                diag(pxtc.DiagnosticCategory.Error, node, code, msg, arg0, arg1, arg2);
            }
            function unhandled(n, info, code = 9202) {
                // If we have info then we may as well present that instead
                if (info) {
                    return userError(code, info);
                }
                if (!n) {
                    userError(code, lf("Sorry, this language feature is not supported"));
                }
                let syntax = stringKind(n);
                let maybeSupportInFuture = false;
                let alternative = null;
                switch (n.kind) {
                    case ts.SyntaxKind.ForInStatement:
                        syntax = lf("for in loops");
                        break;
                    case ts.SyntaxKind.ForOfStatement:
                        syntax = lf("for of loops");
                        maybeSupportInFuture = true;
                        break;
                    case ts.SyntaxKind.PropertyAccessExpression:
                        syntax = lf("property access");
                        break;
                    case ts.SyntaxKind.DeleteExpression:
                        syntax = lf("delete");
                        break;
                    case ts.SyntaxKind.GetAccessor:
                        syntax = lf("get accessor method");
                        maybeSupportInFuture = true;
                        break;
                    case ts.SyntaxKind.SetAccessor:
                        syntax = lf("set accessor method");
                        maybeSupportInFuture = true;
                        break;
                    case ts.SyntaxKind.TaggedTemplateExpression:
                        syntax = lf("tagged templates");
                        break;
                    case ts.SyntaxKind.SpreadElement:
                        syntax = lf("spread");
                        break;
                    case ts.SyntaxKind.TryStatement:
                    case ts.SyntaxKind.CatchClause:
                    case ts.SyntaxKind.FinallyKeyword:
                    case ts.SyntaxKind.ThrowStatement:
                        syntax = lf("throwing and catching exceptions");
                        break;
                    case ts.SyntaxKind.ClassExpression:
                        syntax = lf("class expressions");
                        alternative = lf("declare a class as class C {} not let C = class {}");
                        break;
                    default:
                        break;
                }
                let msg = "";
                if (maybeSupportInFuture) {
                    msg = lf("{0} not currently supported", syntax);
                }
                else {
                    msg = lf("{0} not supported", ts.SyntaxKind[n.kind]);
                }
                if (alternative) {
                    msg += " - " + alternative;
                }
                return userError(code, msg);
            }
            function nodeKey(f) {
                return getNodeId(f) + "";
            }
            function getFunctionInfo(f) {
                const info = pxtInfo(f);
                if (!info.functionInfo)
                    info.functionInfo = new FunctionAddInfo(f);
                return info.functionInfo;
            }
            function getVarInfo(v) {
                const info = pxtInfo(v);
                if (!info.variableInfo) {
                    info.variableInfo = {};
                }
                return info.variableInfo;
            }
            function recordUse(v, written = false) {
                let info = getVarInfo(v);
                if (written)
                    info.written = true;
                let varParent = getEnclosingFunction(v);
                if (varParent == null || varParent == proc.action) {
                    // not captured
                }
                else {
                    let curr = proc.action;
                    while (curr && curr != varParent) {
                        let info2 = getFunctionInfo(curr);
                        if (info2.capturedVars.indexOf(v) < 0)
                            info2.capturedVars.push(v);
                        curr = getEnclosingFunction(curr);
                    }
                    info.captured = true;
                }
            }
            function recordAction(f) {
                const r = f(bin);
                if (needsUsingInfo)
                    bin.recordAction(currUsingContext, f);
                return r;
            }
            function getIfaceMemberId(name, markUsed = false) {
                return recordAction(bin => {
                    if (markUsed) {
                        if (!pxtc.U.lookup(bin.explicitlyUsedIfaceMembers, name)) {
                            pxtc.U.assert(!bin.finalPass);
                            bin.explicitlyUsedIfaceMembers[name] = true;
                        }
                    }
                    let v = pxtc.U.lookup(bin.ifaceMemberMap, name);
                    if (v != null)
                        return v;
                    pxtc.U.assert(!bin.finalPass);
                    // this gets renumbered before the final pass
                    v = bin.ifaceMemberMap[name] = -1;
                    bin.emitString(name);
                    return v;
                });
            }
            function finalEmit() {
                if (opts.noEmit)
                    return;
                bin.writeFile = (fn, data) => {
                    res.outfiles[fn] = data;
                };
                for (let proc of bin.procs)
                    if (!proc.cachedJS || proc.inlineBody)
                        proc.resolve();
                if (pxtc.target.isNative)
                    bin.procs = bin.procs.filter(p => p.inlineBody && !p.info.usedAsIface && !p.info.usedAsValue ? false : true);
                if (opts.target.isNative) {
                    // collect various output files from all variants
                    [...(opts.otherMultiVariants || []), opts].forEach(({ extinfo }) => {
                        if (extinfo.yotta)
                            bin.writeFile("yotta.json", JSON.stringify(extinfo.yotta, null, 2));
                        if (extinfo.codal)
                            bin.writeFile("codal.json", JSON.stringify(extinfo.codal, null, 2));
                        if (extinfo.platformio)
                            bin.writeFile("platformio.json", JSON.stringify(extinfo.platformio, null, 2));
                    });
                    if (opts.target.nativeType == pxtc.NATIVE_TYPE_VM)
                        pxtc.vmEmit(bin, opts);
                    else
                        pxtc.processorEmit(bin, opts, res);
                }
                else {
                    pxtc.jsEmit(bin);
                }
            }
            function typeCheckVar(tp) {
                if (tp.flags & ts.TypeFlags.Void) {
                    userError(9203, lf("void-typed variables not supported"));
                }
            }
            function emitGlobal(decl) {
                const pinfo = pxtInfo(decl);
                typeCheckVar(typeOf(decl));
                if (!pinfo.cell)
                    pinfo.cell = new pxtc.ir.Cell(null, decl, getVarInfo(decl));
                if (bin.globals.indexOf(pinfo.cell) < 0)
                    bin.globals.push(pinfo.cell);
            }
            function lookupCell(decl) {
                if (isGlobalVar(decl)) {
                    markUsed(decl);
                    const pinfo = pxtInfo(decl);
                    if (!pinfo.cell)
                        emitGlobal(decl);
                    return pinfo.cell;
                }
                else {
                    let res = proc.localIndex(decl);
                    if (!res) {
                        if (bin.finalPass)
                            userError(9204, lf("cannot locate identifer"));
                        else {
                            res = proc.mkLocal(decl, getVarInfo(decl));
                        }
                    }
                    return res;
                }
            }
            function getBaseClassInfo(node) {
                if (node.heritageClauses)
                    for (let h of node.heritageClauses) {
                        switch (h.token) {
                            case pxtc.SK.ExtendsKeyword:
                                if (!h.types || h.types.length != 1)
                                    throw userError(9228, lf("invalid extends clause"));
                                let superType = typeOf(h.types[0]);
                                if (superType && isClassType(superType)) {
                                    // check if user defined
                                    // let filename = getSourceFileOfNode(tp.symbol.valueDeclaration).fileName
                                    // if (program.getRootFileNames().indexOf(filename) == -1) {
                                    //    throw userError(9228, lf("cannot inherit from built-in type."))
                                    // }
                                    // need to redo subtype checking on members
                                    let subType = checker.getTypeAtLocation(node);
                                    typeCheckSubtoSup(subType, superType);
                                    return getClassInfo(superType);
                                }
                                else {
                                    throw userError(9228, lf("cannot inherit from this type"));
                                }
                            // ignore it - implementation of interfaces is implicit
                            case pxtc.SK.ImplementsKeyword:
                                break;
                            default:
                                throw userError(9228, lf("invalid heritage clause"));
                        }
                    }
                return null;
            }
            function isToString(m) {
                return m.kind == pxtc.SK.MethodDeclaration &&
                    m.parameters.length == 0 &&
                    getName(m) == "toString";
            }
            function fixpointVTables() {
                needsUsingInfo = false;
                const prevLen = bin.usedClassInfos.length;
                for (let ci of bin.usedClassInfos) {
                    for (let m of ci.allMethods()) {
                        const pinfo = pxtInfo(m);
                        const info = getFunctionInfo(m);
                        if (pinfo.flags & 8 /* IsUsed */) {
                            // we need to mark the parent as used, otherwise vtable layout fails, see #3740
                            if (info.virtualParent)
                                markFunctionUsed(info.virtualParent.decl);
                        }
                        else if (info.virtualParent && info.virtualParent.isUsed) {
                            // if our parent method is used, and our vtable is used,
                            // we are also used
                            markFunctionUsed(m);
                        }
                        else if (isToString(m) || isIfaceMemberUsed(getName(m))) {
                            // if the name is used in interface context, also mark as used
                            markFunctionUsed(m);
                        }
                    }
                    const ctor = getCtor(ci.decl);
                    if (ctor) {
                        markFunctionUsed(ctor);
                    }
                }
                needsUsingInfo = true;
                if (usedWorkList.length == 0 && prevLen == bin.usedClassInfos.length)
                    return true;
                return false;
            }
            function getVTable(inf) {
                pxtc.assert(inf.isUsed, "inf.isUsed");
                if (inf.vtable)
                    return inf.vtable;
                let tbl = inf.baseClassInfo ? getVTable(inf.baseClassInfo).slice(0) : [];
                inf.derivedClasses = [];
                if (inf.baseClassInfo)
                    inf.baseClassInfo.derivedClasses.push(inf);
                for (let m of inf.usedMethods()) {
                    bin.numMethods++;
                    let minf = getFunctionInfo(m);
                    const attrs = parseComments(m);
                    if (isToString(m) && !attrs.shim) {
                        inf.toStringMethod = lookupProc(m);
                        inf.toStringMethod.info.usedAsIface = true;
                    }
                    if (minf.virtualParent) {
                        bin.numVirtMethods++;
                        let key = classFunctionKey(m);
                        let done = false;
                        let proc = lookupProc(m);
                        pxtc.U.assert(!!proc);
                        for (let i = 0; i < tbl.length; ++i) {
                            if (classFunctionKey(tbl[i].action) == key) {
                                tbl[i] = proc;
                                minf.virtualIndex = i;
                                done = true;
                            }
                        }
                        if (!done) {
                            minf.virtualIndex = tbl.length;
                            tbl.push(proc);
                        }
                    }
                }
                inf.vtable = tbl;
                inf.itable = [];
                const fieldNames = {};
                for (let fld of inf.allfields) {
                    let fname = getName(fld);
                    let finfo = fieldIndexCore(inf, fld, false);
                    fieldNames[fname] = true;
                    inf.itable.push({
                        name: fname,
                        info: (finfo.idx + 1) * (isStackMachine() ? 1 : 4),
                        idx: getIfaceMemberId(fname),
                        proc: null
                    });
                }
                for (let curr = inf; curr; curr = curr.baseClassInfo) {
                    for (let m of curr.usedMethods()) {
                        const n = getName(m);
                        const attrs = parseComments(m);
                        if (attrs.shim)
                            continue;
                        const proc = lookupProc(m);
                        const ex = inf.itable.find(e => e.name == n);
                        const isSet = m.kind == pxtc.SK.SetAccessor;
                        const isGet = m.kind == pxtc.SK.GetAccessor;
                        if (ex) {
                            if (isSet && !ex.setProc)
                                ex.setProc = proc;
                            else if (isGet && !ex.proc)
                                ex.proc = proc;
                            ex.info = 0;
                        }
                        else {
                            inf.itable.push({
                                name: n,
                                info: 0,
                                idx: getIfaceMemberId(n),
                                proc: !isSet ? proc : null,
                                setProc: isSet ? proc : null
                            });
                        }
                        proc.info.usedAsIface = true;
                    }
                }
                return inf.vtable;
            }
            // this code determines if we will need a vtable entry
            // by checking if we are overriding a method in a super class
            function computeVtableInfo(info) {
                for (let currMethod of info.allMethods()) {
                    let baseMethod = null;
                    const key = classFunctionKey(currMethod);
                    const k = getName(currMethod);
                    for (let base = info.baseClassInfo; !!base; base = base.baseClassInfo) {
                        if (base.methods.hasOwnProperty(k))
                            for (let m2 of base.methods[k])
                                if (classFunctionKey(m2) == key) {
                                    baseMethod = m2;
                                    // note thare's no 'break' here - we'll go to uppermost
                                    // matching method
                                }
                    }
                    if (baseMethod) {
                        let minf = getFunctionInfo(currMethod);
                        let pinf = getFunctionInfo(baseMethod);
                        // TODO we can probably drop this check
                        if (baseMethod.parameters.length != currMethod.parameters.length)
                            error(currMethod, 9255, lf("the overriding method is currently required to have the same number of arguments as the base one"));
                        // pinf is the transitive parent
                        minf.virtualParent = pinf;
                        if (!pinf.virtualParent) {
                            needsFullRecompileIfCached(pxtInfo(baseMethod));
                            pinf.virtualParent = pinf;
                        }
                        pxtc.assert(pinf.virtualParent == pinf, "pinf.virtualParent == pinf");
                    }
                }
            }
            function needsFullRecompileIfCached(pxtinfo) {
                if ((pxtinfo.flags & 32 /* FromPreviousCompile */) ||
                    (pxtinfo.flags & 16 /* InPxtModules */ &&
                        pxtc.compileOptions.skipPxtModulesEmit)) {
                    res.needsFullRecompile = true;
                    throw userError(9200, lf("full recompile required"));
                }
            }
            function getClassInfo(t, decl = null) {
                if (!decl)
                    decl = t.symbol.valueDeclaration;
                const pinfo = pxtInfo(decl);
                if (!pinfo.classInfo) {
                    const id = safeName(decl) + "__C" + getNodeId(decl);
                    const info = new ClassInfo(id, decl);
                    pinfo.classInfo = info;
                    if (info.attrs.autoCreate)
                        autoCreateFunctions[info.attrs.autoCreate] = true;
                    // only do it after storing ours in case we run into cycles (which should be errors)
                    info.baseClassInfo = getBaseClassInfo(decl);
                    const prevFields = info.baseClassInfo
                        ? pxtc.U.toDictionary(info.baseClassInfo.allfields, f => getName(f)) : {};
                    const prevMethod = (n, c = info.baseClassInfo) => {
                        if (!c)
                            return null;
                        return c.methods[n] || prevMethod(n, c.baseClassInfo);
                    };
                    for (let mem of decl.members) {
                        if (mem.kind == pxtc.SK.PropertyDeclaration) {
                            let pdecl = mem;
                            if (!isStatic(pdecl))
                                info.allfields.push(pdecl);
                            const key = getName(pdecl);
                            if (prevMethod(key) || pxtc.U.lookup(prevFields, key))
                                error(pdecl, 9279, lf("redefinition of '{0}' as field", key));
                        }
                        else if (mem.kind == pxtc.SK.Constructor) {
                            for (let p of mem.parameters) {
                                if (isCtorField(p))
                                    info.allfields.push(p);
                            }
                        }
                        else if (isClassFunction(mem)) {
                            let minf = getFunctionInfo(mem);
                            minf.parentClassInfo = info;
                            if (minf.isUsed)
                                markVTableUsed(info);
                            const key = getName(mem);
                            if (!info.methods.hasOwnProperty(key))
                                info.methods[key] = [];
                            info.methods[key].push(mem);
                            const pfield = pxtc.U.lookup(prevFields, key);
                            if (pfield) {
                                const pxtinfo = pxtInfo(pfield);
                                if (!(pxtinfo.flags & 64 /* IsOverridden */)) {
                                    pxtinfo.flags |= 64 /* IsOverridden */;
                                    if (pxtinfo.flags & 8 /* IsUsed */)
                                        getIfaceMemberId(key, true);
                                    needsFullRecompileIfCached(pxtinfo);
                                }
                                // error(mem, 9279, lf("redefinition of '{0}' (previously a field)", key))
                            }
                        }
                    }
                    if (info.baseClassInfo) {
                        info.allfields = info.baseClassInfo.allfields.concat(info.allfields);
                        computeVtableInfo(info);
                    }
                }
                return pinfo.classInfo;
            }
            function emitImageLiteral(s) {
                if (!s)
                    s = "0 0 0 0 0\n0 0 0 0 0\n0 0 0 0 0\n0 0 0 0 0\n0 0 0 0 0\n";
                let x = 0;
                let w = 0;
                let h = 0;
                let lit = "";
                let c = 0;
                s += "\n";
                for (let i = 0; i < s.length; ++i) {
                    switch (s[i]) {
                        case ".":
                        case "_":
                        case "0":
                            lit += "0,";
                            x++;
                            c++;
                            break;
                        case "#":
                        case "*":
                        case "1":
                            lit += "255,";
                            x++;
                            c++;
                            break;
                        case "\t":
                        case "\r":
                        case " ": break;
                        case "\n":
                            if (x) {
                                if (w == 0)
                                    w = x;
                                else if (x != w)
                                    userError(9205, lf("lines in image literal have to have the same width (got {0} and then {1} pixels)", w, x));
                                x = 0;
                                h++;
                            }
                            break;
                        default:
                            userError(9206, lf("Only 0 . _ (off) and 1 # * (on) are allowed in image literals"));
                    }
                }
                let lbl = "_img" + bin.lblNo++;
                // Pad with a 0 if we have an odd number of pixels
                if (c % 2 != 0)
                    lit += "0";
                // this is codal's format!
                bin.otherLiterals.push(`
.balign 4
${lbl}: .short 0xffff
        .short ${w}, ${h}
        .byte ${lit}
`);
                let jsLit = "new pxsim.Image(" + w + ", [" + lit + "])";
                return {
                    kind: pxtc.SK.NumericLiteral,
                    imageLiteral: lbl,
                    jsLit
                };
            }
            function isGlobalConst(decl) {
                if (isGlobalVar(decl) && (decl.parent.flags & ts.NodeFlags.Const))
                    return true;
                return false;
            }
            function isSideEffectfulInitializer(init) {
                if (!init)
                    return false;
                if (isStringLiteral(init))
                    return false;
                switch (init.kind) {
                    case pxtc.SK.ArrayLiteralExpression:
                        return init.elements.some(isSideEffectfulInitializer);
                    default:
                        return constantFold(init) == null;
                }
            }
            function emitLocalLoad(decl) {
                const folded = constantFoldDecl(decl);
                if (folded)
                    return emitLit(folded.val);
                if (isGlobalVar(decl)) {
                    const attrs = parseComments(decl);
                    if (attrs.shim)
                        return emitShim(decl, decl, []);
                }
                let l = lookupCell(decl);
                recordUse(decl);
                let r = l.load();
                //console.log("LOADLOC", l.toString(), r.toString())
                return r;
            }
            function emitFunLiteral(f) {
                let attrs = parseComments(f);
                if (attrs.shim)
                    userError(9207, lf("built-in functions cannot be yet used as values; did you forget ()?"));
                let info = getFunctionInfo(f);
                markUsageOrder(info);
                if (info.location) {
                    return info.location.load();
                }
                else {
                    pxtc.assert(!bin.finalPass || info.capturedVars.length == 0, "!bin.finalPass || info.capturedVars.length == 0");
                    info.usedAsValue = true;
                    markFunctionUsed(f);
                    return emitFunLitCore(f);
                }
            }
            function markUsageOrder(info) {
                if (info.usedBeforeDecl === undefined)
                    info.usedBeforeDecl = true;
                else if (bin.finalPass && info.usedBeforeDecl && info.capturedVars.length) {
                    if (getEnclosingFunction(info.decl) && !info.alreadyEmitted)
                        userError(9278, lf("function referenced before all variables it uses are defined"));
                }
            }
            function emitIdentifier(node) {
                const decl = getDecl(node);
                const fold = constantFoldDecl(decl);
                if (fold)
                    return emitLit(fold.val);
                if (decl && (isVar(decl) || isParameter(decl))) {
                    return emitLocalLoad(decl);
                }
                else if (decl && decl.kind == pxtc.SK.FunctionDeclaration) {
                    return emitFunLiteral(decl);
                }
                else {
                    if (node.text == "undefined")
                        return emitLit(undefined);
                    else
                        throw unhandled(node, lf("Unknown or undeclared identifier"), 9235);
                }
            }
            function emitParameter(node) { }
            function emitAccessor(node) {
                emitFunctionDeclaration(node);
            }
            function emitThis(node) {
                let meth = getEnclosingMethod(node);
                if (!meth)
                    userError(9208, lf("'this' used outside of a method"));
                let inf = getFunctionInfo(meth);
                if (!inf.thisParameter) {
                    //console.log("get this param,", meth.kind, nodeKey(meth))
                    //console.log("GET", meth)
                    pxtc.oops("no this");
                }
                return emitLocalLoad(inf.thisParameter);
            }
            function emitSuper(node) { }
            function emitStringLiteral(str) {
                let r;
                if (str == "") {
                    r = pxtc.ir.rtcall("String_::mkEmpty", []);
                }
                else {
                    let lbl = emitAndMarkString(str);
                    r = pxtc.ir.ptrlit(lbl, JSON.stringify(str));
                }
                r.isStringLiteral = true;
                return r;
            }
            function emitLiteral(node) {
                if (node.kind == pxtc.SK.NumericLiteral) {
                    if (node.imageLiteral) {
                        return pxtc.ir.ptrlit(node.imageLiteral, node.jsLit);
                    }
                    else {
                        const parsed = parseFloat(node.text);
                        return emitLit(parsed);
                    }
                }
                else if (isStringLiteral(node)) {
                    return emitStringLiteral(node.text);
                }
                else {
                    throw pxtc.oops();
                }
            }
            function asString(e) {
                let isRef = isRefCountedExpr(e);
                let expr = emitExpr(e);
                if (pxtc.target.isNative || isStringLiteral(e))
                    return irToNode(expr, isRef);
                expr = pxtc.ir.rtcallMask("String_::stringConv", 1, 1 /* Async */, [expr]);
                return irToNode(expr, true);
            }
            function emitTemplateExpression(node) {
                let numconcat = 0;
                let concat = (a, b) => {
                    if (isEmptyStringLiteral(b))
                        return a;
                    numconcat++;
                    return rtcallMask("String_::concat", [irToNode(a, true), asString(b)], null);
                };
                let expr = pxtInfo(asString(node.head)).valueOverride;
                for (let span of node.templateSpans) {
                    expr = concat(expr, span.expression);
                    expr = concat(expr, span.literal);
                }
                if (numconcat == 0) {
                    // make sure `${foo}` == foo.toString(), not just foo
                    return rtcallMask("String_::concat", [
                        irToNode(expr, true),
                        irToNode(pxtc.ir.rtcall("String_::mkEmpty", []), false)
                    ], null);
                }
                return expr;
            }
            function emitTemplateSpan(node) { }
            function emitJsxElement(node) { }
            function emitJsxSelfClosingElement(node) { }
            function emitJsxText(node) { }
            function emitJsxExpression(node) { }
            function emitQualifiedName(node) { }
            function emitObjectBindingPattern(node) { }
            function emitArrayBindingPattern(node) { }
            function emitArrayLiteral(node) {
                let eltT = arrayElementType(typeOf(node));
                let coll = pxtc.ir.shared(pxtc.ir.rtcall("Array_::mk", []));
                for (let elt of node.elements) {
                    let mask = isRefCountedExpr(elt) ? 2 : 0;
                    proc.emitExpr(pxtc.ir.rtcall("Array_::push", [coll, emitExpr(elt)], mask));
                }
                return coll;
            }
            function emitObjectLiteral(node) {
                let expr = pxtc.ir.shared(pxtc.ir.rtcall("pxtrt::mkMap", []));
                node.properties.forEach((p) => {
                    pxtc.assert(!p.questionToken); // should be disallowed by TS grammar checker
                    let keyName;
                    let init;
                    if (p.kind == pxtc.SK.ShorthandPropertyAssignment) {
                        const sp = p;
                        pxtc.assert(!sp.equalsToken && !sp.objectAssignmentInitializer); // disallowed by TS grammar checker
                        keyName = p.name.text;
                        const vsym = checker.getShorthandAssignmentValueSymbol(p);
                        const vname = vsym && vsym.valueDeclaration && vsym.valueDeclaration.name;
                        if (vname && vname.kind == pxtc.SK.Identifier)
                            init = emitIdentifier(vname);
                        else
                            throw unhandled(p); // not sure what happened
                    }
                    else if (p.name.kind == pxtc.SK.ComputedPropertyName) {
                        const keyExpr = p.name.expression;
                        // need to use rtcallMask, so keyExpr gets converted to string
                        proc.emitExpr(rtcallMask("pxtrt::mapSetByString", [
                            irToNode(expr, true),
                            keyExpr,
                            p.initializer
                        ], null));
                        return;
                    }
                    else {
                        keyName = p.name.kind == pxtc.SK.StringLiteral ?
                            p.name.text : p.name.getText();
                        init = emitExpr(p.initializer);
                    }
                    const fieldId = pxtc.target.isNative
                        ? pxtc.ir.numlit(getIfaceMemberId(keyName))
                        : pxtc.ir.ptrlit(null, JSON.stringify(keyName));
                    const args = [
                        expr,
                        fieldId,
                        init
                    ];
                    proc.emitExpr(pxtc.ir.rtcall(pxtc.target.isNative ? "pxtrt::mapSet" : "pxtrt::mapSetByString", args));
                });
                return expr;
            }
            function emitPropertyAssignment(node) {
                if (isStatic(node)) {
                    emitVariableDeclaration(node);
                    return;
                }
                if (node.initializer) {
                    let info = getClassInfo(typeOf(node.parent));
                    if (bin.finalPass && info.isUsed && !info.ctor)
                        userError(9209, lf("class field initializers currently require an explicit constructor"));
                }
                // do nothing
            }
            function emitShorthandPropertyAssignment(node) { }
            function emitComputedPropertyName(node) { }
            function emitPropertyAccess(node) {
                let decl = getDecl(node);
                const fold = constantFoldDecl(decl);
                if (fold)
                    return emitLit(fold.val);
                if (decl.kind == pxtc.SK.SetAccessor)
                    decl = checkGetter(decl);
                if (decl.kind == pxtc.SK.GetAccessor)
                    return emitCallCore(node, node, [], null, decl);
                if (decl.kind == pxtc.SK.EnumMember) {
                    throw userError(9210, lf("Cannot compute enum value"));
                }
                else if (decl.kind == pxtc.SK.PropertySignature || decl.kind == pxtc.SK.PropertyAssignment) {
                    return emitCallCore(node, node, [], null, decl, node.expression);
                }
                else if (decl.kind == pxtc.SK.PropertyDeclaration || decl.kind == pxtc.SK.Parameter) {
                    if (isStatic(decl)) {
                        return emitLocalLoad(decl);
                    }
                    if (isSlowField(decl)) {
                        // treat as interface call
                        return emitCallCore(node, node, [], null, decl, node.expression);
                    }
                    else {
                        let idx = fieldIndex(node);
                        return pxtc.ir.op(EK.FieldAccess, [emitExpr(node.expression)], idx);
                    }
                }
                else if (isClassFunction(decl) || decl.kind == pxtc.SK.MethodSignature) {
                    // TODO this is now supported in runtime; can be probably relaxed (by using GetAccessor code path above)
                    throw userError(9211, lf("cannot use method as lambda; did you forget '()' ?"));
                }
                else if (decl.kind == pxtc.SK.FunctionDeclaration) {
                    return emitFunLiteral(decl);
                }
                else if (isVar(decl)) {
                    return emitLocalLoad(decl);
                }
                else {
                    throw unhandled(node, lf("Unknown property access for {0}", stringKind(decl)), 9237);
                }
            }
            function checkGetter(decl) {
                const getter = ts.getDeclarationOfKind(decl.symbol, pxtc.SK.GetAccessor);
                if (getter == null) {
                    throw userError(9281, lf("setter currently requires a corresponding getter"));
                }
                else {
                    return getter;
                }
            }
            function isSlowField(decl) {
                if (decl.kind == pxtc.SK.Parameter || decl.kind == pxtc.SK.PropertyDeclaration) {
                    const pinfo = pxtInfo(decl);
                    return !!pxtc.target.switches.slowFields || !!(pinfo.flags & 64 /* IsOverridden */);
                }
                return false;
            }
            function emitIndexedAccess(node, assign = null) {
                let t = typeOf(node.expression);
                let attrs = {
                    callingConvention: 0 /* Plain */,
                    paramDefl: {},
                };
                let indexer = null;
                let stringOk = false;
                if (!assign && isStringType(t)) {
                    indexer = "String_::charAt";
                }
                else if (isArrayType(t)) {
                    indexer = assign ? "Array_::setAt" : "Array_::getAt";
                }
                else if (isInterfaceType(t)) {
                    attrs = parseCommentsOnSymbol(t.symbol);
                    indexer = assign ? attrs.indexerSet : attrs.indexerGet;
                }
                if (!indexer && (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.StructuredOrTypeVariable))) {
                    indexer = assign ? "pxtrt::mapSetGeneric" : "pxtrt::mapGetGeneric";
                    stringOk = true;
                }
                if (indexer) {
                    if (stringOk || isNumberLike(node.argumentExpression)) {
                        let args = [node.expression, node.argumentExpression];
                        return rtcallMask(indexer, args, attrs, assign ? [assign] : []);
                    }
                    else {
                        throw unhandled(node, lf("non-numeric indexer on {0}", indexer), 9238);
                    }
                }
                else {
                    throw unhandled(node, lf("unsupported indexer"), 9239);
                }
            }
            function isOnDemandGlobal(decl) {
                if (!isGlobalVar(decl))
                    return false;
                let v = decl;
                if (!isSideEffectfulInitializer(v.initializer))
                    return true;
                let attrs = parseComments(decl);
                if (attrs.whenUsed)
                    return true;
                return false;
            }
            function isOnDemandDecl(decl) {
                let res = isOnDemandGlobal(decl) || isTopLevelFunctionDecl(decl) || ts.isClassDeclaration(decl);
                if (pxtc.target.switches.noTreeShake)
                    return false;
                if (opts.testMode && res) {
                    if (!isInPxtModules(decl))
                        return false;
                }
                return res;
            }
            function shouldEmitNow(node) {
                if (!isOnDemandDecl(node))
                    return true;
                const info = pxtInfo(node);
                if (bin.finalPass)
                    return !!(info.flags & 8 /* IsUsed */);
                else
                    return info == currUsingContext;
            }
            function markUsed(decl) {
                if (!decl)
                    return;
                const pinfo = pxtInfo(decl);
                if (pinfo.classInfo) {
                    markVTableUsed(pinfo.classInfo);
                    return;
                }
                if (opts.computeUsedSymbols && decl.symbol)
                    res.usedSymbols[getNodeFullName(checker, decl)] = null;
                if (isStackMachine() && isClassFunction(decl))
                    getIfaceMemberId(getName(decl), true);
                recordUsage(decl);
                if (!(pinfo.flags & 8 /* IsUsed */)) {
                    pinfo.flags |= 8 /* IsUsed */;
                    if (isOnDemandDecl(decl))
                        usedWorkList.push(decl);
                }
            }
            function markFunctionUsed(decl) {
                markUsed(decl);
            }
            function emitAndMarkString(str) {
                return recordAction(bin => {
                    return bin.emitString(str);
                });
            }
            function recordUsage(decl) {
                if (!needsUsingInfo)
                    return;
                if (!currUsingContext) {
                    pxtc.U.oops("no using ctx for: " + getName(decl));
                }
                else {
                    currUsingContext.usedNodes[nodeKey(decl)] = decl;
                }
            }
            function getDeclCore(node) {
                if (!node)
                    return null;
                const pinfo = pxtInfo(node);
                if (pinfo.declCache !== undefined)
                    return pinfo.declCache;
                let sym = checker.getSymbolAtLocation(node);
                let decl;
                if (sym) {
                    decl = sym.valueDeclaration;
                    if (!decl && sym.declarations) {
                        let decl0 = sym.declarations[0];
                        if (decl0 && decl0.kind == ts.SyntaxKind.ImportEqualsDeclaration) {
                            sym = checker.getSymbolAtLocation(decl0.moduleReference);
                            if (sym)
                                decl = sym.valueDeclaration;
                        }
                    }
                }
                return decl;
            }
            function getDecl(node) {
                let decl = getDeclCore(node);
                markUsed(decl);
                if (!decl && node && node.kind == pxtc.SK.PropertyAccessExpression) {
                    const namedNode = node;
                    decl = {
                        kind: pxtc.SK.PropertySignature,
                        symbol: { isBogusSymbol: true, name: namedNode.name.getText() },
                        name: namedNode.name,
                    };
                    pxtInfo(decl).flags |= 2 /* IsBogusFunction */;
                }
                pinfo.declCache = decl || null;
                return decl;
            }
            function isRefCountedExpr(e) {
                // we generate a fake NULL expression for default arguments
                // we also generate a fake numeric literal for image literals
                if (e.kind == pxtc.SK.NullKeyword || e.kind == pxtc.SK.NumericLiteral)
                    return !!e.isRefOverride;
                // no point doing the incr/decr for these - they are statically allocated anyways (unless on AVR)
                if (isStringLiteral(e))
                    return false;
                return true;
            }
            function getMask(args) {
                pxtc.assert(args.length <= 8, "args.length <= 8");
                let m = 0;
                args.forEach((a, i) => {
                    if (isRefCountedExpr(a))
                        m |= (1 << i);
                });
                return m;
            }
            function emitShim(decl, node, args) {
                let attrs = parseComments(decl);
                let hasRet = !(typeOf(node).flags & ts.TypeFlags.Void);
                let nm = attrs.shim;
                if (nm.indexOf('(') >= 0) {
                    let parse = /(.*)\((.*)\)$/.exec(nm);
                    if (parse) {
                        if (args.length)
                            pxtc.U.userError("no arguments expected");
                        let litargs = [];
                        let strargs = parse[2].replace(/\s/g, "");
                        if (strargs) {
                            for (let a of parse[2].split(/,/)) {
                                let v = parseInt(a);
                                if (isNaN(v)) {
                                    v = lookupDalConst(node, a);
                                    if (v == null)
                                        v = lookupConfigConst(node, a);
                                    if (v == null)
                                        pxtc.U.userError("invalid argument: " + a + " in " + nm);
                                }
                                litargs.push(pxtc.ir.numlit(v));
                            }
                            if (litargs.length > 4)
                                pxtc.U.userError("too many args");
                        }
                        nm = parse[1];
                        if (opts.target.isNative) {
                            pxtc.hexfile.validateShim(getDeclName(decl), nm, attrs, true, litargs.map(v => true));
                        }
                        return pxtc.ir.rtcallMask(nm, 0, attrs.callingConvention, litargs);
                    }
                }
                if (nm == "TD_NOOP") {
                    pxtc.assert(!hasRet, "!hasRet");
                    if (pxtc.target.switches.profile && attrs.shimArgument == "perfCounter") {
                        if (args[0] && args[0].kind == pxtc.SK.StringLiteral)
                            proc.perfCounterName = args[0].text;
                        if (!proc.perfCounterName)
                            proc.perfCounterName = proc.getFullName();
                    }
                    return emitLit(undefined);
                }
                if (nm == "TD_ID" || nm === "ENUM_GET") {
                    pxtc.assert(args.length == 1, "args.length == 1");
                    return emitExpr(args[0]);
                }
                if (opts.target.shimRenames && pxtc.U.lookup(opts.target.shimRenames, nm))
                    nm = opts.target.shimRenames[nm];
                if (opts.target.isNative) {
                    pxtc.hexfile.validateShim(getDeclName(decl), nm, attrs, hasRet, args.map(isNumberLike));
                }
                return rtcallMask(nm, args, attrs);
            }
            function isNumericLiteral(node) {
                switch (node.kind) {
                    case pxtc.SK.UndefinedKeyword:
                    case pxtc.SK.NullKeyword:
                    case pxtc.SK.TrueKeyword:
                    case pxtc.SK.FalseKeyword:
                    case pxtc.SK.NumericLiteral:
                        return true;
                    case pxtc.SK.PropertyAccessExpression:
                        let r = emitExpr(node);
                        return r.exprKind == EK.NumberLiteral;
                    default:
                        return false;
                }
            }
            function addDefaultParametersAndTypeCheck(sig, args, attrs) {
                if (!sig)
                    return;
                let parms = sig.getParameters();
                // remember the number of arguments passed explicitly
                let goodToGoLength = args.length;
                if (parms.length > args.length) {
                    parms.slice(args.length).forEach(p => {
                        if (p.valueDeclaration &&
                            p.valueDeclaration.kind == pxtc.SK.Parameter) {
                            let prm = p.valueDeclaration;
                            if (!prm.initializer) {
                                let defl = getExplicitDefault(attrs, getName(prm));
                                let expr = defl ? emitLit(parseInt(defl)) : null;
                                if (expr == null) {
                                    expr = emitLit(undefined);
                                }
                                args.push(irToNode(expr));
                            }
                            else {
                                if (!isNumericLiteral(prm.initializer)) {
                                    userError(9212, lf("only numbers, null, true and false supported as default arguments"));
                                }
                                args.push(prm.initializer);
                            }
                        }
                        else {
                            userError(9213, lf("unsupported default argument (shouldn't happen)"));
                        }
                    });
                }
                // type check for assignment of actual to formal,
                // TODO: checks for the rest needed
                for (let i = 0; i < goodToGoLength; i++) {
                    let p = parms[i];
                    // there may be more arguments than parameters
                    if (p && p.valueDeclaration && p.valueDeclaration.kind == pxtc.SK.Parameter)
                        typeCheckSubtoSup(args[i], p.valueDeclaration);
                }
                // TODO: this is micro:bit specific and should be lifted out
                if (attrs.imageLiteral) {
                    if (!isStringLiteral(args[0])) {
                        userError(9214, lf("Only image literals (string literals) supported here; {0}", stringKind(args[0])));
                    }
                    args[0] = emitImageLiteral(args[0].text);
                }
            }
            function emitCallExpression(node) {
                const sig = checker.getResolvedSignature(node);
                return emitCallCore(node, node.expression, node.arguments, sig);
            }
            function emitCallCore(node, funcExpr, callArgs, sig, decl = null, recv = null) {
                var _a;
                if (!decl)
                    decl = getDecl(funcExpr);
                let hasRecv = false;
                let forceMethod = false;
                let isStaticLike = false;
                const noArgs = node === funcExpr;
                if (decl) {
                    switch (decl.kind) {
                        // these can be implemented by fields
                        case pxtc.SK.PropertySignature:
                        case pxtc.SK.PropertyAssignment:
                        case pxtc.SK.PropertyDeclaration:
                        case pxtc.SK.MethodSignature:
                            hasRecv = true;
                            break;
                        case pxtc.SK.Parameter:
                            if (isCtorField(decl))
                                hasRecv = true;
                            break;
                        // these are all class members, so cannot be implemented by fields
                        case pxtc.SK.GetAccessor:
                        case pxtc.SK.SetAccessor:
                        case pxtc.SK.MethodDeclaration:
                            hasRecv = true;
                            forceMethod = true;
                            isStaticLike = isStatic(decl);
                            break;
                        case pxtc.SK.FunctionDeclaration:
                            isStaticLike = true;
                            break;
                        case pxtc.SK.ModuleDeclaration:
                            // has special handling
                            break;
                        default:
                            decl = null; // no special handling
                            break;
                    }
                }
                else {
                    if (funcExpr.kind == pxtc.SK.PropertyAccessExpression)
                        hasRecv = true; // any-access
                }
                if (pxtc.target.switches.slowMethods)
                    forceMethod = false;
                const attrs = parseComments(decl);
                let args = callArgs.slice(0);
                if (hasRecv && isStatic(decl))
                    hasRecv = false;
                if (hasRecv && !recv && funcExpr.kind == pxtc.SK.PropertyAccessExpression)
                    recv = funcExpr.expression;
                if (res.usedArguments && attrs.trackArgs) {
                    let targs = recv ? [recv].concat(args) : args;
                    let tracked = attrs.trackArgs.map(n => targs[n]).map(e => {
                        let d = getDecl(e);
                        if (d && (d.kind == pxtc.SK.EnumMember || d.kind == pxtc.SK.VariableDeclaration))
                            return getNodeFullName(checker, d);
                        else if (e && e.kind == pxtc.SK.StringLiteral)
                            return e.text;
                        else
                            return "*";
                    }).join(",");
                    let fn = getNodeFullName(checker, decl);
                    let lst = res.usedArguments[fn];
                    if (!lst) {
                        lst = res.usedArguments[fn] = [];
                    }
                    if (lst.indexOf(tracked) < 0)
                        lst.push(tracked);
                }
                function emitPlain() {
                    let r = mkProcCall(decl, node, args.map((x) => emitExpr(x)));
                    let pp = r.data;
                    if (args[0] && pp.proc && pp.proc.classInfo)
                        pp.isThis = args[0].kind == pxtc.SK.ThisKeyword;
                    return r;
                }
                addDefaultParametersAndTypeCheck(sig, args, attrs);
                // first we handle a set of direct cases, note that
                // we are not recursing on funcExpr here, but looking
                // at the associated decl
                if (isStaticLike) {
                    let info = getFunctionInfo(decl);
                    if (!info.location) {
                        if (attrs.shim && !hasShimDummy(decl)) {
                            return emitShim(decl, node, args);
                        }
                        markFunctionUsed(decl);
                        return emitPlain();
                    }
                }
                // special case call to super
                if (funcExpr.kind == pxtc.SK.SuperKeyword) {
                    let baseCtor = proc.classInfo.baseClassInfo.ctor;
                    for (let p = proc.classInfo.baseClassInfo; p && !baseCtor; p = p.baseClassInfo)
                        baseCtor = p.ctor;
                    if (!baseCtor && bin.finalPass)
                        throw userError(9280, lf("super() call requires an explicit constructor in base class"));
                    let ctorArgs = args.map((x) => emitExpr(x));
                    ctorArgs.unshift(emitThis(funcExpr));
                    return mkProcCallCore(baseCtor, node, ctorArgs);
                }
                if (hasRecv) {
                    pxtc.U.assert(!isStatic(decl));
                    if (recv) {
                        args.unshift(recv);
                    }
                    else {
                        unhandled(node, lf("strange method call"), 9241);
                    }
                    if (!decl) {
                        // TODO in VT accessor/field/method -> different
                        pxtc.U.assert(funcExpr.kind == pxtc.SK.PropertyAccessExpression);
                        const fieldName = funcExpr.name.text;
                        // completely dynamic dispatch
                        return mkMethodCall(args.map((x) => emitExpr(x)), {
                            ifaceIndex: getIfaceMemberId(fieldName, true),
                            callLocationIndex: markCallLocation(node),
                            noArgs
                        });
                    }
                    let info = getFunctionInfo(decl);
                    if (info.parentClassInfo)
                        markVTableUsed(info.parentClassInfo);
                    markFunctionUsed(decl);
                    if (recv.kind == pxtc.SK.SuperKeyword)
                        return emitPlain();
                    const needsVCall = !!info.virtualParent;
                    const forceIfaceCall = !!isStackMachine() || !!pxtc.target.switches.slowMethods;
                    if (needsVCall && !forceIfaceCall) {
                        if (decl.kind == pxtc.SK.MethodDeclaration) {
                            pxtc.U.assert(!noArgs);
                        }
                        else if (decl.kind == pxtc.SK.GetAccessor || decl.kind == pxtc.SK.SetAccessor) {
                            pxtc.U.assert(noArgs);
                        }
                        else {
                            pxtc.U.assert(false);
                        }
                        pxtc.U.assert(!bin.finalPass || info.virtualIndex != null, "!bin.finalPass || info.virtualIndex != null");
                        return mkMethodCall(args.map((x) => emitExpr(x)), {
                            classInfo: info.parentClassInfo,
                            virtualIndex: info.virtualIndex,
                            noArgs,
                            isThis: args[0].kind == pxtc.SK.ThisKeyword
                        });
                    }
                    if (attrs.shim && !hasShimDummy(decl)) {
                        return emitShim(decl, node, args);
                    }
                    else if (attrs.helper) {
                        let syms = checker.getSymbolsInScope(node, ts.SymbolFlags.Module);
                        let helperStmt;
                        for (let sym of syms) {
                            if (sym.name == "helpers") {
                                for (let d of sym.declarations || [sym.valueDeclaration]) {
                                    if (d.kind == pxtc.SK.ModuleDeclaration) {
                                        for (let stmt of d.body.statements) {
                                            if (((_a = stmt.symbol) === null || _a === void 0 ? void 0 : _a.name) == attrs.helper) {
                                                helperStmt = stmt;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        if (!helperStmt)
                            userError(9215, lf("helpers.{0} not found", attrs.helper));
                        if (helperStmt.kind != pxtc.SK.FunctionDeclaration)
                            userError(9216, lf("helpers.{0} isn't a function", attrs.helper));
                        decl = helperStmt;
                        markFunctionUsed(decl);
                        return emitPlain();
                    }
                    else if (needsVCall || pxtc.target.switches.slowMethods || !forceMethod) {
                        return mkMethodCall(args.map((x) => emitExpr(x)), {
                            ifaceIndex: getIfaceMemberId(getName(decl), true),
                            isSet: noArgs && args.length == 2,
                            callLocationIndex: markCallLocation(node),
                            noArgs
                        });
                    }
                    else {
                        pxtc.U.assert(decl.kind != pxtc.SK.MethodSignature);
                        return emitPlain();
                    }
                }
                if (decl && decl.kind == pxtc.SK.ModuleDeclaration) {
                    if (getName(decl) == "String")
                        userError(9219, lf("to convert X to string use: X + \"\""));
                    else
                        userError(9220, lf("namespaces cannot be called directly"));
                }
                // here's where we will recurse to generate funcExpr
                args.unshift(funcExpr);
                pxtc.U.assert(!noArgs);
                return mkMethodCall(args.map(x => emitExpr(x)), {
                    virtualIndex: -1,
                    callLocationIndex: markCallLocation(node),
                    noArgs
                });
            }
            function mkProcCallCore(proc, callLocation, args) {
                pxtc.U.assert(!bin.finalPass || !!proc);
                let data = {
                    proc: proc,
                    callLocationIndex: markCallLocation(callLocation),
                    virtualIndex: null,
                    ifaceIndex: null
                };
                return pxtc.ir.op(EK.ProcCall, args, data);
            }
            function mkMethodCall(args, info) {
                return pxtc.ir.op(EK.ProcCall, args, info);
            }
            function lookupProc(decl) {
                return pxtInfo(decl).proc;
            }
            function mkProcCall(decl, callLocation, args) {
                const proc = lookupProc(decl);
                if (decl.kind == pxtc.SK.FunctionDeclaration) {
                    const info = getFunctionInfo(decl);
                    markUsageOrder(info);
                }
                pxtc.assert(!!proc || !bin.finalPass, "!!proc || !bin.finalPass");
                return mkProcCallCore(proc, callLocation, args);
            }
            function layOutGlobals() {
                let globals = bin.globals.slice(0);
                // stable-sort globals, with smallest first, because "strh/b" have
                // smaller immediate range than plain "str" (and same for "ldr")
                // All the pointers go at the end, for GC
                globals.forEach((g, i) => g.index = i);
                const sz = (b) => b == 0 /* None */ ? 10 : sizeOfBitSize(b);
                globals.sort((a, b) => sz(a.bitSize) - sz(b.bitSize) ||
                    a.index - b.index);
                let currOff = pxtc.numReservedGlobals * 4;
                let firstPointer = 0;
                for (let g of globals) {
                    const bitSize = isStackMachine() ? 0 /* None */ : g.bitSize;
                    let sz = sizeOfBitSize(bitSize);
                    while (currOff & (sz - 1))
                        currOff++; // align
                    if (!firstPointer && bitSize == 0 /* None */)
                        firstPointer = currOff;
                    g.index = currOff;
                    currOff += sz;
                }
                bin.globalsWords = (currOff + 3) >> 2;
                bin.nonPtrGlobals = firstPointer ? (firstPointer >> 2) : bin.globalsWords;
            }
            function emitVTables() {
                for (let info of bin.usedClassInfos) {
                    getVTable(info); // gets cached
                }
                let keys = Object.keys(bin.ifaceMemberMap);
                keys.sort(pxtc.U.strcmp);
                keys.unshift(""); // make sure idx=0 is invalid
                bin.emitString("");
                bin.ifaceMembers = keys;
                bin.ifaceMemberMap = {};
                let idx = 0;
                for (let k of keys) {
                    bin.ifaceMemberMap[k] = idx++;
                }
                for (let info of bin.usedClassInfos) {
                    for (let e of info.itable) {
                        e.idx = getIfaceMemberId(e.name);
                    }
                }
                for (let info of bin.usedClassInfos) {
                    info.lastSubtypeNo = undefined;
                    info.classNo = undefined;
                }
                let classNo = pxt.BuiltInType.User0;
                const numberClasses = (i) => {
                    pxtc.U.assert(!i.classNo);
                    i.classNo = classNo++;
                    for (let subt of i.derivedClasses)
                        if (subt.isUsed)
                            numberClasses(subt);
                    i.lastSubtypeNo = classNo - 1;
                };
                for (let info of bin.usedClassInfos) {
                    let par = info;
                    while (par.baseClassInfo)
                        par = par.baseClassInfo;
                    if (!par.classNo)
                        numberClasses(par);
                }
            }
            function getCtor(decl) {
                return decl.members.filter(m => m.kind == pxtc.SK.Constructor)[0];
            }
            function isIfaceMemberUsed(name) {
                return pxtc.U.lookup(bin.explicitlyUsedIfaceMembers, name) != null;
            }
            function markVTableUsed(info) {
                recordUsage(info.decl);
                if (info.isUsed)
                    return;
                // U.assert(!bin.finalPass)
                const pinfo = pxtInfo(info.decl);
                pinfo.flags |= 8 /* IsUsed */;
                if (info.baseClassInfo)
                    markVTableUsed(info.baseClassInfo);
                bin.usedClassInfos.push(info);
            }
            function emitNewExpression(node) {
                let t = checker.getTypeAtLocation(node);
                if (t && isArrayType(t)) {
                    throw pxtc.oops();
                }
                else if (t && isPossiblyGenericClassType(t)) {
                    let classDecl = getDecl(node.expression);
                    if (classDecl.kind != pxtc.SK.ClassDeclaration) {
                        userError(9221, lf("new expression only supported on class types"));
                    }
                    let ctor;
                    let info = getClassInfo(typeOf(node), classDecl);
                    // find ctor to call in base chain
                    for (let parinfo = info; parinfo; parinfo = parinfo.baseClassInfo) {
                        ctor = getCtor(parinfo.decl);
                        if (ctor)
                            break;
                    }
                    markVTableUsed(info);
                    let lbl = info.id + "_VT";
                    let obj = pxtc.ir.rtcall("pxt::mkClassInstance", [pxtc.ir.ptrlit(lbl, lbl)]);
                    if (ctor) {
                        obj = sharedDef(obj);
                        markUsed(ctor);
                        // arguments undefined on .ctor with optional args
                        let args = (node.arguments || []).slice(0);
                        let ctorAttrs = parseComments(ctor);
                        // unused?
                        // let sig = checker.getResolvedSignature(node)
                        // TODO: can we have overloeads?
                        addDefaultParametersAndTypeCheck(checker.getResolvedSignature(node), args, ctorAttrs);
                        let compiled = args.map((x) => emitExpr(x));
                        if (ctorAttrs.shim) {
                            // TODO need to deal with refMask and tagged ints here
                            // we drop 'obj' variable
                            return pxtc.ir.rtcall(ctorAttrs.shim, compiled);
                        }
                        compiled.unshift(obj);
                        proc.emitExpr(mkProcCall(ctor, node, compiled));
                        return obj;
                    }
                    else {
                        if (node.arguments && node.arguments.length)
                            userError(9222, lf("constructor with arguments not found"));
                        return obj;
                    }
                }
                else {
                    throw unhandled(node, lf("unknown type for new"), 9243);
                }
            }
            /* Requires the following to be declared in global scope:
                //% shim=@hex
                function hex(lits: any, ...args: any[]): Buffer { return null }
            */
            function emitTaggedTemplateExpression(node) {
                function isHexDigit(c) {
                    return /^[0-9a-f]$/i.test(c);
                }
                function f4PreProcess(s) {
                    if (!Array.isArray(attrs.groups))
                        throw unhandled(node, lf("missing groups in @f4 literal"), 9272);
                    let matrix = [];
                    let line = [];
                    let tbl = {};
                    let maxLen = 0;
                    attrs.groups.forEach((str, n) => {
                        for (let c of str)
                            tbl[c] = n;
                    });
                    s += "\n";
                    for (let i = 0; i < s.length; ++i) {
                        let c = s[i];
                        switch (c) {
                            case ' ':
                            case '\t':
                                break;
                            case '\n':
                                if (line.length > 0) {
                                    matrix.push(line);
                                    maxLen = Math.max(line.length, maxLen);
                                    line = [];
                                }
                                break;
                            default:
                                let v = pxtc.U.lookup(tbl, c);
                                if (v == null) {
                                    if (attrs.groups.length == 2)
                                        v = 1; // default anything non-zero to one
                                    else
                                        throw unhandled(node, lf("invalid character in image literal: '{0}'", v), 9273);
                                }
                                line.push(v);
                                break;
                        }
                    }
                    let bpp = 8;
                    if (attrs.groups.length <= 2) {
                        bpp = 1;
                    }
                    else if (attrs.groups.length <= 16) {
                        bpp = 4;
                    }
                    return pxtc.f4EncodeImg(maxLen, matrix.length, bpp, (x, y) => matrix[y][x] || 0);
                }
                function parseHexLiteral(node, s) {
                    let thisJres = currJres;
                    if (s[0] == '_' && s[1] == '_' && opts.jres[s]) {
                        thisJres = opts.jres[s];
                        s = "";
                    }
                    if (s == "" && thisJres) {
                        let fontMatch = /font\/x-mkcd-b(\d+)/.exec(thisJres.mimeType);
                        if (fontMatch) {
                            if (!bin.finalPass) {
                                s = "aabbccdd";
                            }
                            else {
                                let chsz = parseInt(fontMatch[1]);
                                let data = atob(thisJres.data);
                                let mask = bin.usedChars;
                                let buf = "";
                                let incl = "";
                                for (let pos = 0; pos < data.length; pos += chsz) {
                                    let charcode = data.charCodeAt(pos) + (data.charCodeAt(pos + 1) << 8);
                                    if (charcode < 128 || (mask[charcode >> 5] & (1 << (charcode & 31)))) {
                                        buf += data.slice(pos, pos + chsz);
                                        incl += charcode + ", ";
                                    }
                                }
                                s = pxtc.U.toHex(pxtc.U.stringToUint8Array(buf));
                            }
                        }
                        else if (!thisJres.dataEncoding || thisJres.dataEncoding == "base64") {
                            s = pxtc.U.toHex(pxtc.U.stringToUint8Array(ts.pxtc.decodeBase64(thisJres.data)));
                        }
                        else if (thisJres.dataEncoding == "hex") {
                            s = thisJres.data;
                        }
                        else {
                            userError(9271, lf("invalid jres encoding '{0}' on '{1}'", thisJres.dataEncoding, thisJres.id));
                        }
                    }
                    if (/^e[14]/i.test(s) && node.parent && node.parent.kind == pxtc.SK.CallExpression &&
                        node.parent.expression.getText() == "image.ofBuffer") {
                        const m = /^e([14])(..)(..)..(.*)/i.exec(s);
                        s = `870${m[1]}${m[2]}00${m[3]}000000${m[4]}`;
                    }
                    let res = "";
                    for (let i = 0; i < s.length; ++i) {
                        let c = s[i];
                        if (isHexDigit(c)) {
                            if (isHexDigit(s[i + 1])) {
                                res += c + s[i + 1];
                                i++;
                            }
                        }
                        else if (/^[\s\.]$/.test(c))
                            continue;
                        else
                            throw unhandled(node, lf("invalid character in hex literal '{0}'", c), 9265);
                    }
                    if (pxtc.target.isNative) {
                        const lbl = bin.emitHexLiteral(res.toLowerCase());
                        return pxtc.ir.ptrlit(lbl, lbl);
                    }
                    else {
                        const lbl = "_hex" + nodeKey(node);
                        return pxtc.ir.ptrlit(lbl, { hexlit: res.toLowerCase() });
                    }
                }
                let decl = getDecl(node.tag);
                if (!decl)
                    throw unhandled(node, lf("invalid tagged template"), 9265);
                let attrs = parseComments(decl);
                let res;
                let callInfo = {
                    decl,
                    qName: decl ? getNodeFullName(checker, decl) : "?",
                    args: [node.template],
                    isExpression: true
                };
                pxtInfo(node).callInfo = callInfo;
                function handleHexLike(pp) {
                    res = parseHexLiteral(node, pp(node.template.text));
                }
                if (node.template.kind != pxtc.SK.NoSubstitutionTemplateLiteral)
                    throw unhandled(node, lf("substitution not supported in hex literal", attrs.shim), 9265);
                switch (attrs.shim) {
                    case "@hex":
                        handleHexLike(s => s);
                        break;
                    case "@f4":
                        handleHexLike(f4PreProcess);
                        break;
                    default:
                        if (attrs.shim === undefined && attrs.helper) {
                            return emitTaggedTemplateHelper(node.template, attrs);
                        }
                        throw unhandled(node, lf("invalid shim '{0}' on tagged template", attrs.shim), 9265);
                }
                if (attrs.helper) {
                    res = pxtc.ir.rtcall(attrs.helper, [res]);
                }
                return res;
            }
            function emitTypeAssertion(node) {
                typeCheckSubtoSup(node.expression, node);
                return emitExpr(node.expression);
            }
            function emitAsExpression(node) {
                typeCheckSubtoSup(node.expression, node);
                return emitExpr(node.expression);
            }
            function emitParenExpression(node) {
                return emitExpr(node.expression);
            }
            function emitTaggedTemplateHelper(node, attrs) {
                var _a;
                let syms = checker.getSymbolsInScope(node, ts.SymbolFlags.Module);
                let helperStmt;
                for (let sym of syms) {
                    if (sym.name == "helpers") {
                        for (let d of sym.declarations || [sym.valueDeclaration]) {
                            if (d.kind == pxtc.SK.ModuleDeclaration) {
                                for (let stmt of d.body.statements) {
                                    if (((_a = stmt.symbol) === null || _a === void 0 ? void 0 : _a.name) == attrs.helper) {
                                        helperStmt = stmt;
                                    }
                                }
                            }
                        }
                    }
                }
                if (!helperStmt)
                    userError(9215, lf("helpers.{0} not found", attrs.helper));
                if (helperStmt.kind != pxtc.SK.FunctionDeclaration)
                    userError(9216, lf("helpers.{0} isn't a function", attrs.helper));
                const decl = helperStmt;
                markFunctionUsed(decl);
                let r = mkProcCall(decl, node, [emitStringLiteral(node.text)]);
                return r;
            }
            function getParameters(node) {
                let res = node.parameters.slice(0);
                if (!isStatic(node) && isClassFunction(node)) {
                    let info = getFunctionInfo(node);
                    if (!info.thisParameter) {
                        info.thisParameter = {
                            kind: pxtc.SK.Parameter,
                            name: { text: "this" },
                            isThisParameter: true,
                            parent: node
                        };
                    }
                    res.unshift(info.thisParameter);
                }
                return res;
            }
            function emitFunLitCore(node, raw = false) {
                let lbl = getFunctionLabel(node);
                return pxtc.ir.ptrlit(lbl + "_Lit", lbl);
            }
            function flushWorkQueue() {
                proc = lookupProc(rootFunction);
                // we emit everything that's left, but only at top level
                // to avoid unbounded stack
                while (usedWorkList.length > 0) {
                    let f = usedWorkList.pop();
                    emitTopLevel(f);
                }
            }
            function flushHoistedFunctionDefinitions() {
                const curr = pendingFunctionDefinitions;
                if (curr.length > 0) {
                    pendingFunctionDefinitions = [];
                    for (let node of curr) {
                        const prevProc = proc;
                        try {
                            emitFuncCore(node);
                        }
                        finally {
                            proc = prevProc;
                        }
                    }
                }
            }
            function markVariableDefinition(vi) {
                if (bin.finalPass && vi.functionsToDefine) {
                    pxtc.U.pushRange(pendingFunctionDefinitions, vi.functionsToDefine);
                }
            }
            function emitFuncCore(node) {
                const info = getFunctionInfo(node);
                let lit = null;
                if (bin.finalPass) {
                    if (info.alreadyEmitted) {
                        pxtc.U.assert(info.usedBeforeDecl);
                        return null;
                    }
                    info.alreadyEmitted = true;
                }
                let isExpression = node.kind == pxtc.SK.ArrowFunction || node.kind == pxtc.SK.FunctionExpression;
                let caps = info.capturedVars.slice(0);
                let locals = caps.map((v, i) => {
                    let l = new pxtc.ir.Cell(i, v, getVarInfo(v));
                    l.iscap = true;
                    return l;
                });
                if (info.usedBeforeDecl === undefined)
                    info.usedBeforeDecl = false;
                // if no captured variables, then we can get away with a plain pointer to code
                if (caps.length > 0) {
                    pxtc.assert(getEnclosingFunction(node) != null, "getEnclosingFunction(node) != null)");
                    lit = pxtc.ir.shared(pxtc.ir.rtcall("pxt::mkAction", [pxtc.ir.numlit(caps.length), emitFunLitCore(node, true)]));
                    info.usedAsValue = true;
                    caps.forEach((l, i) => {
                        let loc = proc.localIndex(l);
                        if (!loc)
                            userError(9223, lf("cannot find captured value: {0}", checker.symbolToString(l.symbol)));
                        let v = loc.loadCore();
                        proc.emitExpr(pxtc.ir.rtcall("pxtrt::stclo", [lit, pxtc.ir.numlit(i), v]));
                    });
                    if (node.kind == pxtc.SK.FunctionDeclaration) {
                        info.location = proc.mkLocal(node, getVarInfo(node));
                        proc.emitExpr(info.location.storeDirect(lit));
                        lit = null;
                    }
                }
                else {
                    if (isExpression) {
                        lit = emitFunLitCore(node);
                        info.usedAsValue = true;
                    }
                }
                pxtc.assert(!!lit == isExpression, "!!lit == isExpression");
                let existing = lookupProc(node);
                if (existing) {
                    proc = existing;
                    proc.reset();
                }
                else {
                    pxtc.assert(!bin.finalPass, "!bin.finalPass");
                    const pinfo = pxtInfo(node);
                    const myProc = new pxtc.ir.Procedure();
                    myProc.isRoot = !!(pinfo.flags & 1 /* IsRootFunction */);
                    myProc.action = node;
                    myProc.info = info;
                    pinfo.proc = myProc;
                    myProc.usingCtx = currUsingContext;
                    proc = myProc;
                    recordAction(bin => bin.addProc(myProc));
                }
                proc.captured = locals;
                const initalizedFields = [];
                if (node.parent.kind == pxtc.SK.ClassDeclaration) {
                    let parClass = node.parent;
                    let classInfo = getClassInfo(null, parClass);
                    if (proc.classInfo)
                        pxtc.assert(proc.classInfo == classInfo, "proc.classInfo == classInfo");
                    else
                        proc.classInfo = classInfo;
                    if (node.kind == pxtc.SK.Constructor) {
                        if (classInfo.baseClassInfo) {
                            for (let m of classInfo.baseClassInfo.decl.members) {
                                if (m.kind == pxtc.SK.Constructor)
                                    markFunctionUsed(m);
                            }
                        }
                        if (classInfo.ctor)
                            pxtc.assert(classInfo.ctor == proc, "classInfo.ctor == proc");
                        else
                            classInfo.ctor = proc;
                        for (let f of classInfo.allfields) {
                            if (f.kind == pxtc.SK.PropertyDeclaration && !isStatic(f)) {
                                let fi = f;
                                if (fi.initializer)
                                    initalizedFields.push(fi);
                            }
                        }
                    }
                }
                const destructuredParameters = [];
                const fieldAssignmentParameters = [];
                proc.args = getParameters(node).map((p, i) => {
                    if (p.name.kind === pxtc.SK.ObjectBindingPattern) {
                        destructuredParameters.push(p);
                    }
                    if (node.kind == pxtc.SK.Constructor && isCtorField(p)) {
                        fieldAssignmentParameters.push(p);
                    }
                    let l = new pxtc.ir.Cell(i, p, getVarInfo(p));
                    markVariableDefinition(l.info);
                    l.isarg = true;
                    return l;
                });
                proc.args.forEach(l => {
                    //console.log(l.toString(), l.info)
                    if (l.isByRefLocal()) {
                        // TODO add C++ support function to do this
                        let tmp = pxtc.ir.shared(pxtc.ir.rtcall("pxtrt::mklocRef", []));
                        proc.emitExpr(pxtc.ir.rtcall("pxtrt::stlocRef", [tmp, l.loadCore()], 1));
                        proc.emitExpr(l.storeDirect(tmp));
                    }
                });
                destructuredParameters.forEach(dp => emitVariableDeclaration(dp));
                // for constructor(public foo:number) generate this.foo = foo;
                for (let p of fieldAssignmentParameters) {
                    let idx = fieldIndexCore(proc.classInfo, getFieldInfo(proc.classInfo, getName(p)), false);
                    let trg2 = pxtc.ir.op(EK.FieldAccess, [emitLocalLoad(info.thisParameter)], idx);
                    proc.emitExpr(pxtc.ir.op(EK.Store, [trg2, emitLocalLoad(p)]));
                }
                for (let f of initalizedFields) {
                    let idx = fieldIndexCore(proc.classInfo, getFieldInfo(proc.classInfo, getName(f)), false);
                    let trg2 = pxtc.ir.op(EK.FieldAccess, [emitLocalLoad(info.thisParameter)], idx);
                    proc.emitExpr(pxtc.ir.op(EK.Store, [trg2, emitExpr(f.initializer)]));
                }
                flushHoistedFunctionDefinitions();
                if (node.body.kind == pxtc.SK.Block) {
                    emit(node.body);
                    if (funcHasReturn(proc.action)) {
                        const last = proc.body[proc.body.length - 1];
                        if (last && last.stmtKind == pxtc.ir.SK.Jmp && last.jmpMode == pxtc.ir.JmpMode.Always) {
                            // skip final 'return undefined' as there was 'return something' just above
                        }
                        else {
                            proc.emitJmp(getLabels(node).ret, emitLit(undefined), pxtc.ir.JmpMode.Always);
                        }
                    }
                }
                else {
                    let v = emitExpr(node.body);
                    proc.emitJmp(getLabels(node).ret, v, pxtc.ir.JmpMode.Always);
                }
                proc.emitLblDirect(getLabels(node).ret);
                proc.stackEmpty();
                let lbl = proc.mkLabel("final");
                if (funcHasReturn(proc.action)) {
                    // the jmp will take R0 with it as the return value
                    proc.emitJmp(lbl);
                }
                else {
                    proc.emitJmp(lbl, emitLit(undefined));
                }
                proc.emitLbl(lbl);
                if (info.capturedVars.length &&
                    info.usedBeforeDecl &&
                    node.kind == pxtc.SK.FunctionDeclaration && !bin.finalPass) {
                    info.capturedVars.sort((a, b) => b.pos - a.pos);
                    const vinfo = getVarInfo(info.capturedVars[0]);
                    if (!vinfo.functionsToDefine)
                        vinfo.functionsToDefine = [];
                    vinfo.functionsToDefine.push(node);
                }
                // nothing should be on work list in final pass - everything should be already marked as used
                pxtc.assert(!bin.finalPass || usedWorkList.length == 0, "!bin.finalPass || usedWorkList.length == 0");
                return lit;
            }
            function sharedDef(e) {
                let v = pxtc.ir.shared(e);
                // make sure we save it
                proc.emitExpr(v);
                return v;
            }
            function captureJmpValue() {
                return sharedDef(pxtc.ir.op(EK.JmpValue, []));
            }
            function hasShimDummy(node) {
                if (opts.target.isNative)
                    return false;
                let f = node;
                return f.body && (f.body.kind != pxtc.SK.Block || f.body.statements.length > 0);
            }
            function emitFunctionDeclaration(node) {
                if (!shouldEmitNow(node))
                    return undefined;
                if (pxtInfo(node).flags & 32 /* FromPreviousCompile */)
                    return undefined;
                let attrs = parseComments(node);
                if (attrs.shim != null) {
                    if (attrs.shim[0] == "@")
                        return undefined;
                    if (opts.target.isNative) {
                        pxtc.hexfile.validateShim(getDeclName(node), attrs.shim, attrs, funcHasReturn(node), getParameters(node).map(p => isNumberLikeType(typeOf(p))));
                    }
                    if (!hasShimDummy(node))
                        return undefined;
                }
                if (ts.isInAmbientContext(node))
                    return undefined;
                if (!node.body)
                    return undefined;
                let lit = null;
                let prevProc = proc;
                try {
                    lit = emitFuncCore(node);
                }
                finally {
                    proc = prevProc;
                }
                return lit;
            }
            function emitDeleteExpression(node) {
                let objExpr;
                let keyExpr;
                if (node.expression.kind == pxtc.SK.PropertyAccessExpression) {
                    const inner = node.expression;
                    objExpr = inner.expression;
                    keyExpr = irToNode(emitStringLiteral(inner.name.text));
                }
                else if (node.expression.kind == pxtc.SK.ElementAccessExpression) {
                    const inner = node.expression;
                    objExpr = inner.expression;
                    keyExpr = inner.argumentExpression;
                }
                else {
                    throw userError(9276, lf("expression not supported as argument to 'delete'"));
                }
                // we know these would just fail at runtime
                const objExprType = typeOf(objExpr);
                if (isClassType(objExprType))
                    throw userError(9277, lf("'delete' not supported on class types"));
                if (isArrayType(objExprType))
                    throw userError(9277, lf("'delete' not supported on array"));
                return rtcallMask("pxtrt::mapDeleteByString", [objExpr, keyExpr], null);
            }
            function emitTypeOfExpression(node) {
                return rtcallMask("pxt::typeOf", [node.expression], null);
            }
            function emitVoidExpression(node) { }
            function emitAwaitExpression(node) { }
            function emitPrefixUnaryExpression(node) {
                const folded = constantFold(node);
                if (folded)
                    return emitLit(folded.val);
                switch (node.operator) {
                    case pxtc.SK.ExclamationToken:
                        return fromBool(pxtc.ir.rtcall("Boolean_::bang", [emitCondition(node.operand)]));
                    case pxtc.SK.PlusPlusToken:
                        return emitIncrement(node.operand, "numops::adds", false);
                    case pxtc.SK.MinusMinusToken:
                        return emitIncrement(node.operand, "numops::subs", false);
                    case pxtc.SK.PlusToken:
                    case pxtc.SK.MinusToken: {
                        let inner = emitExpr(node.operand);
                        let v = valueToInt(inner);
                        if (v != null)
                            return emitLit(-v);
                        if (node.operator == pxtc.SK.MinusToken)
                            return emitIntOp("numops::subs", emitLit(0), inner);
                        else
                            // force conversion to number
                            return emitIntOp("numops::subs", inner, emitLit(0));
                    }
                    case pxtc.SK.TildeToken: {
                        let inner = emitExpr(node.operand);
                        let v = valueToInt(inner);
                        if (v != null)
                            return emitLit(~v);
                        return rtcallMaskDirect(mapIntOpName("numops::bnot"), [inner]);
                    }
                    default:
                        throw unhandled(node, lf("unsupported prefix unary operation"), 9245);
                }
            }
            function doNothing() { }
            function needsCache(e) {
                let c = e;
                c.needsIRCache = true;
                irCachesToClear.push(c);
            }
            function prepForAssignment(trg, src = null) {
                let prev = irCachesToClear.length;
                if (trg.kind == pxtc.SK.PropertyAccessExpression || trg.kind == pxtc.SK.ElementAccessExpression) {
                    needsCache(trg.expression);
                }
                if (src)
                    needsCache(src);
                if (irCachesToClear.length == prev)
                    return doNothing;
                else
                    return () => {
                        for (let i = prev; i < irCachesToClear.length; ++i) {
                            irCachesToClear[i].cachedIR = null;
                            irCachesToClear[i].needsIRCache = false;
                        }
                        irCachesToClear.splice(prev, irCachesToClear.length - prev);
                    };
            }
            function irToNode(expr, isRef = false) {
                let r = {
                    kind: pxtc.SK.NullKeyword,
                    isRefOverride: isRef,
                };
                pxtInfo(r).valueOverride = expr;
                return r;
            }
            function emitIncrement(trg, meth, isPost, one = null) {
                let cleanup = prepForAssignment(trg);
                let oneExpr = one ? emitExpr(one) : emitLit(1);
                let prev = pxtc.ir.shared(emitExpr(trg));
                let result = pxtc.ir.shared(emitIntOp(meth, prev, oneExpr));
                emitStore(trg, irToNode(result, true));
                cleanup();
                return isPost ? prev : result;
            }
            function emitPostfixUnaryExpression(node) {
                let tp = typeOf(node.operand);
                if (isNumberType(tp)) {
                    switch (node.operator) {
                        case pxtc.SK.PlusPlusToken:
                            return emitIncrement(node.operand, "numops::adds", true);
                        case pxtc.SK.MinusMinusToken:
                            return emitIncrement(node.operand, "numops::subs", true);
                        default:
                            break;
                    }
                }
                throw unhandled(node, lf("unsupported postfix unary operation"), 9246);
            }
            function fieldIndexCore(info, fld, needsCheck = true) {
                if (isStatic(fld))
                    pxtc.U.oops("fieldIndex on static field: " + getName(fld));
                let attrs = parseComments(fld);
                let idx = info.allfields.indexOf(fld);
                if (idx < 0 && bin.finalPass)
                    pxtc.U.oops("missing field");
                return {
                    idx,
                    name: getName(fld),
                    isRef: true,
                    shimName: attrs.shim,
                    classInfo: info,
                    needsCheck
                };
            }
            function fieldIndex(pacc) {
                const tp = typeOf(pacc.expression);
                if (isPossiblyGenericClassType(tp)) {
                    const info = getClassInfo(tp);
                    let noCheck = pacc.expression.kind == pxtc.SK.ThisKeyword;
                    if (pxtc.target.switches.noThisCheckOpt)
                        noCheck = false;
                    return fieldIndexCore(info, getFieldInfo(info, pacc.name.text), !noCheck);
                }
                else {
                    throw unhandled(pacc, lf("bad field access"), 9247);
                }
            }
            function getFieldInfo(info, fieldName) {
                const field = info.allfields.filter(f => f.name.text == fieldName)[0];
                if (!field) {
                    userError(9224, lf("field {0} not found", fieldName));
                }
                return field;
            }
            function emitStore(trg, src, checkAssign = false) {
                if (checkAssign) {
                    typeCheckSubtoSup(src, trg);
                }
                let decl = getDecl(trg);
                let isGlobal = isGlobalVar(decl);
                if (trg.kind == pxtc.SK.Identifier || isGlobal) {
                    if (decl && (isGlobal || isVar(decl) || isParameter(decl))) {
                        let l = lookupCell(decl);
                        recordUse(decl, true);
                        proc.emitExpr(l.storeByRef(emitExpr(src)));
                    }
                    else {
                        unhandled(trg, lf("bad target identifier"), 9248);
                    }
                }
                else if (trg.kind == pxtc.SK.PropertyAccessExpression) {
                    let decl = getDecl(trg);
                    if (decl && (decl.kind == pxtc.SK.GetAccessor || decl.kind == pxtc.SK.SetAccessor)) {
                        checkGetter(decl);
                        decl = ts.getDeclarationOfKind(decl.symbol, pxtc.SK.SetAccessor);
                        if (!decl) {
                            unhandled(trg, lf("setter not available"), 9253);
                        }
                        proc.emitExpr(emitCallCore(trg, trg, [src], null, decl));
                    }
                    else if (decl && (decl.kind == pxtc.SK.PropertySignature || decl.kind == pxtc.SK.PropertyAssignment || isSlowField(decl))) {
                        proc.emitExpr(emitCallCore(trg, trg, [src], null, decl));
                    }
                    else {
                        let trg2 = emitExpr(trg);
                        proc.emitExpr(pxtc.ir.op(EK.Store, [trg2, emitExpr(src)]));
                    }
                }
                else if (trg.kind == pxtc.SK.ElementAccessExpression) {
                    proc.emitExpr(emitIndexedAccess(trg, src));
                }
                else if (trg.kind == pxtc.SK.ArrayLiteralExpression) {
                    // special-case [a,b,c]=[1,2,3], or more commonly [a,b]=[b,a]
                    if (src.kind == pxtc.SK.ArrayLiteralExpression) {
                        // typechecker enforces that these two have the same length
                        const tmps = src.elements.map(e => {
                            const ee = pxtc.ir.shared(emitExpr(e));
                            proc.emitExpr(ee);
                            return ee;
                        });
                        trg.elements.forEach((e, idx) => {
                            emitStore(e, irToNode(tmps[idx]));
                        });
                    }
                    else {
                        // unfortunately, this uses completely different syntax tree nodes to the patters in const/let...
                        const bindingExpr = pxtc.ir.shared(emitExpr(src));
                        trg.elements.forEach((e, idx) => {
                            emitStore(e, irToNode(rtcallMaskDirect("Array_::getAt", [bindingExpr, pxtc.ir.numlit(idx)])));
                        });
                    }
                }
                else {
                    unhandled(trg, lf("bad assignment target"), 9249);
                }
            }
            function handleAssignment(node) {
                let src = node.right;
                if (node.parent.kind == pxtc.SK.ExpressionStatement)
                    src = null;
                let cleanup = prepForAssignment(node.left, src);
                emitStore(node.left, node.right, true);
                let res = src ? emitExpr(src) : emitLit(undefined);
                cleanup();
                return res;
            }
            function mapIntOpName(n) {
                if (isThumb()) {
                    switch (n) {
                        case "numops::adds":
                        case "numops::subs":
                        case "numops::eors":
                        case "numops::ands":
                        case "numops::orrs":
                            return "@nomask@" + n;
                    }
                }
                if (isStackMachine()) {
                    switch (n) {
                        case "pxt::switch_eq":
                            return "numops::eq";
                    }
                }
                return n;
            }
            function emitIntOp(op, left, right) {
                return rtcallMaskDirect(mapIntOpName(op), [left, right]);
            }
            function unaryOpConst(tok, aa) {
                if (!aa)
                    return null;
                const a = aa.val;
                switch (tok) {
                    case pxtc.SK.PlusToken: return { val: +a };
                    case pxtc.SK.MinusToken: return { val: -a };
                    case pxtc.SK.TildeToken: return { val: ~a };
                    case pxtc.SK.ExclamationToken: return { val: !a };
                    default:
                        return null;
                }
            }
            function binaryOpConst(tok, aa, bb) {
                if (!aa || !bb)
                    return null;
                const a = aa.val;
                const b = bb.val;
                switch (tok) {
                    case pxtc.SK.PlusToken: return { val: a + b };
                    case pxtc.SK.MinusToken: return { val: a - b };
                    case pxtc.SK.SlashToken: return { val: a / b };
                    case pxtc.SK.PercentToken: return { val: a % b };
                    case pxtc.SK.AsteriskToken: return { val: a * b };
                    case pxtc.SK.AsteriskAsteriskToken: return { val: a ** b };
                    case pxtc.SK.AmpersandToken: return { val: a & b };
                    case pxtc.SK.BarToken: return { val: a | b };
                    case pxtc.SK.CaretToken: return { val: a ^ b };
                    case pxtc.SK.LessThanLessThanToken: return { val: a << b };
                    case pxtc.SK.GreaterThanGreaterThanToken: return { val: a >> b };
                    case pxtc.SK.GreaterThanGreaterThanGreaterThanToken: return { val: a >>> b };
                    case pxtc.SK.LessThanEqualsToken: return { val: a <= b };
                    case pxtc.SK.LessThanToken: return { val: a < b };
                    case pxtc.SK.GreaterThanEqualsToken: return { val: a >= b };
                    case pxtc.SK.GreaterThanToken: return { val: a > b };
                    case pxtc.SK.EqualsEqualsToken: return { val: a == b };
                    case pxtc.SK.EqualsEqualsEqualsToken: return { val: a === b };
                    case pxtc.SK.ExclamationEqualsEqualsToken: return { val: a !== b };
                    case pxtc.SK.ExclamationEqualsToken: return { val: a != b };
                    case pxtc.SK.BarBarToken: return { val: a || b };
                    case pxtc.SK.AmpersandAmpersandToken: return { val: a && b };
                    default:
                        return null;
                }
            }
            function quickGetQualifiedName(expr) {
                if (expr.kind == pxtc.SK.Identifier) {
                    return expr.text;
                }
                else if (expr.kind == pxtc.SK.PropertyAccessExpression) {
                    const pa = expr;
                    const left = quickGetQualifiedName(pa.expression);
                    if (left)
                        return left + "." + pa.name.text;
                }
                return null;
            }
            function fun1Const(expr, aa) {
                if (!aa)
                    return null;
                const a = aa.val;
                switch (quickGetQualifiedName(expr)) {
                    case "Math.floor": return { val: Math.floor(a) };
                    case "Math.ceil": return { val: Math.ceil(a) };
                    case "Math.round": return { val: Math.round(a) };
                }
                return null;
            }
            function enumValue(decl) {
                const attrs = parseComments(decl);
                let ev = attrs.enumval;
                if (!ev) {
                    let val = checker.getConstantValue(decl);
                    if (val == null)
                        return null;
                    ev = val + "";
                }
                if (/^[+-]?\d+$/.test(ev))
                    return ev;
                if (/^0x[A-Fa-f\d]{2,8}$/.test(ev))
                    return ev;
                pxtc.U.userError("enumval only support number literals");
                return "0";
            }
            function emitFolded(f) {
                if (f)
                    return emitLit(f.val);
                return null;
            }
            function constantFoldDecl(decl) {
                if (!decl)
                    return null;
                const info = pxtInfo(decl);
                if (info.constantFolded !== undefined)
                    return info.constantFolded;
                if (isVar(decl) && (decl.parent.flags & ts.NodeFlags.Const)) {
                    const vardecl = decl;
                    if (vardecl.initializer)
                        info.constantFolded = constantFold(vardecl.initializer);
                }
                else if (decl.kind == pxtc.SK.EnumMember) {
                    const en = decl;
                    const ev = enumValue(en);
                    if (ev == null) {
                        info.constantFolded = constantFold(en.initializer);
                    }
                    else {
                        const v = parseInt(ev);
                        if (!isNaN(v))
                            info.constantFolded = { val: v };
                    }
                }
                else if (decl.kind == pxtc.SK.PropertyDeclaration && isStatic(decl) && isReadOnly(decl)) {
                    const pd = decl;
                    info.constantFolded = constantFold(pd.initializer);
                }
                //if (info.constantFolded)
                //    console.log(getDeclName(decl), getSourceFileOfNode(decl).fileName, info.constantFolded.val)
                return info.constantFolded;
            }
            function constantFold(e) {
                if (!e)
                    return null;
                const info = pxtInfo(e);
                if (info.constantFolded === undefined) {
                    info.constantFolded = null; // make sure we don't come back here recursively
                    const res = constantFoldCore(e);
                    info.constantFolded = res;
                }
                return info.constantFolded;
            }
            function constantFoldCore(e) {
                if (!e)
                    return null;
                switch (e.kind) {
                    case pxtc.SK.PrefixUnaryExpression: {
                        const expr = e;
                        const inner = constantFold(expr.operand);
                        return unaryOpConst(expr.operator, inner);
                    }
                    case pxtc.SK.BinaryExpression: {
                        const expr = e;
                        const left = constantFold(expr.left);
                        if (!left)
                            return null;
                        const right = constantFold(expr.right);
                        if (!right)
                            return null;
                        return binaryOpConst(expr.operatorToken.kind, left, right);
                    }
                    case pxtc.SK.NumericLiteral: {
                        const expr = e;
                        const v = parseFloat(expr.text);
                        if (isNaN(v))
                            return null;
                        return { val: v };
                    }
                    case pxtc.SK.NullKeyword:
                        return { val: null };
                    case pxtc.SK.TrueKeyword:
                        return { val: true };
                    case pxtc.SK.FalseKeyword:
                        return { val: false };
                    case pxtc.SK.UndefinedKeyword:
                        return { val: undefined };
                    case pxtc.SK.CallExpression: {
                        const expr = e;
                        if (expr.arguments.length == 1)
                            return fun1Const(expr.expression, constantFold(expr.arguments[0]));
                        return null;
                    }
                    case pxtc.SK.PropertyAccessExpression:
                    case pxtc.SK.Identifier:
                        // regular getDecl() will mark symbols as used
                        // if we succeed, we will not use any symbols, so no rason to mark them
                        return constantFoldDecl(getDeclCore(e));
                    case pxtc.SK.AsExpression:
                        return constantFold(e.expression);
                    default:
                        return null;
                }
            }
            function emitAsInt(e) {
                let prev = pxtc.target.switches.boxDebug;
                let expr = null;
                if (prev) {
                    try {
                        pxtc.target.switches.boxDebug = false;
                        expr = emitExpr(e);
                    }
                    finally {
                        pxtc.target.switches.boxDebug = prev;
                    }
                }
                else {
                    expr = emitExpr(e);
                }
                let v = valueToInt(expr);
                if (v === undefined)
                    throw userError(9267, lf("a constant number-like expression is required here"));
                return v;
            }
            function lookupConfigConst(ctx, name) {
                let r = lookupConfigConstCore(ctx, name, "userconfig");
                if (r == null)
                    r = lookupConfigConstCore(ctx, name, "config");
                return r;
            }
            function lookupConfigConstCore(ctx, name, mod) {
                let syms = checker.getSymbolsInScope(ctx, ts.SymbolFlags.Module);
                let configMod = syms.filter(s => s.name == mod && !!s.valueDeclaration)[0];
                if (!configMod)
                    return null;
                for (let stmt of configMod.valueDeclaration.body.statements) {
                    if (stmt.kind == pxtc.SK.VariableStatement) {
                        let v = stmt;
                        for (let d of v.declarationList.declarations) {
                            if (d.symbol.name == name) {
                                return emitAsInt(d.initializer);
                            }
                        }
                    }
                }
                return null;
            }
            function lookupDalConst(ctx, name) {
                let syms = checker.getSymbolsInScope(ctx, ts.SymbolFlags.Enum);
                let dalEnm = syms.filter(s => s.name == "DAL" && !!s.valueDeclaration)[0];
                if (!dalEnm)
                    return null;
                let decl = dalEnm.valueDeclaration.members
                    .filter(s => s.symbol.name == name)[0];
                if (decl)
                    return checker.getConstantValue(decl);
                return null;
            }
            function valueToInt(e) {
                if (e.exprKind == pxtc.ir.EK.NumberLiteral) {
                    let v = e.data;
                    if (opts.target.isNative && !isStackMachine()) {
                        if (v == pxtc.taggedNull || v == pxtc.taggedUndefined || v == pxtc.taggedFalse)
                            return 0;
                        if (v == pxtc.taggedTrue)
                            return 1;
                        if (typeof v == "number")
                            return v >> 1;
                    }
                    else {
                        if (typeof v == "number")
                            return v;
                    }
                }
                else if (e.exprKind == pxtc.ir.EK.RuntimeCall && e.args.length == 2) {
                    let v0 = valueToInt(e.args[0]);
                    let v1 = valueToInt(e.args[1]);
                    if (v0 === undefined || v1 === undefined)
                        return undefined;
                    switch (e.data) {
                        case "numops::orrs":
                            return v0 | v1;
                        case "numops::adds":
                            return v0 + v1;
                        default:
                            console.log(e);
                            return undefined;
                    }
                }
                return undefined;
            }
            function emitLit(v) {
                if (opts.target.isNative && !isStackMachine()) {
                    const numlit = taggedSpecial(v);
                    if (numlit != null)
                        return pxtc.ir.numlit(numlit);
                    else if (typeof v == "number") {
                        if (fitsTaggedInt(v)) {
                            return pxtc.ir.numlit((v << 1) | 1);
                        }
                        else {
                            let lbl = bin.emitDouble(v);
                            return pxtc.ir.ptrlit(lbl, JSON.stringify(v));
                        }
                    }
                    else {
                        throw pxtc.U.oops("bad literal: " + v);
                    }
                }
                else {
                    return pxtc.ir.numlit(v);
                }
            }
            function isNumberLike(e) {
                if (e.kind == pxtc.SK.NullKeyword) {
                    let vo = pxtInfo(e).valueOverride;
                    if (vo != null) {
                        if (vo.exprKind == EK.NumberLiteral) {
                            if (opts.target.isNative)
                                return !!(vo.data & 1);
                            return true;
                        }
                        else if (vo.exprKind == EK.RuntimeCall && vo.data == "pxt::ptrOfLiteral") {
                            if (vo.args[0].exprKind == EK.PointerLiteral &&
                                !isNaN(parseFloat(vo.args[0].jsInfo)))
                                return true;
                            return false;
                        }
                        else if (vo.exprKind == EK.PointerLiteral &&
                            !isNaN(parseFloat(vo.jsInfo))) {
                            return true;
                        }
                        else
                            return false;
                    }
                }
                if (e.kind == pxtc.SK.NumericLiteral)
                    return true;
                return isNumberLikeType(typeOf(e));
            }
            function rtcallMaskDirect(name, args) {
                return pxtc.ir.rtcallMask(name, (1 << args.length) - 1, 0 /* Plain */, args);
            }
            function rtcallMask(name, args, attrs, append = null) {
                let fmt = [];
                let inf = pxtc.hexfile.lookupFunc(name);
                if (isThumb()) {
                    let inf2 = pxtc.U.lookup(thumbFuns, name);
                    if (inf2) {
                        inf = inf2;
                        name = inf2.name;
                    }
                }
                if (inf)
                    fmt = inf.argsFmt;
                if (append)
                    args = args.concat(append);
                let mask = getMask(args);
                let convInfos = [];
                let args2 = args.map((a, i) => {
                    let r = emitExpr(a);
                    if (!needsNumberConversions())
                        return r;
                    let f = fmt[i + 1];
                    let isNumber = isNumberLike(a);
                    if (!f && name.indexOf("::") < 0) {
                        // for assembly functions, make up the format string - pass numbers as ints and everything else as is
                        f = isNumber ? "I" : "_";
                    }
                    if (!f) {
                        throw pxtc.U.userError("not enough args for " + name);
                    }
                    else if (f[0] == "_" || f == "T" || f == "N") {
                        let t = getRefTagToValidate(f);
                        if (t) {
                            convInfos.push({
                                argIdx: i,
                                method: "_validate",
                                refTag: t,
                                refTagNullable: !!attrs.argsNullable
                            });
                        }
                        return r;
                    }
                    else if (f == "I") {
                        //toInt can handle non-number values as well
                        //if (!isNumber)
                        //    U.userError("argsFmt=...I... but argument not a number in " + name)
                        if (r.exprKind == EK.NumberLiteral && typeof r.data == "number") {
                            return pxtc.ir.numlit(r.data >> 1);
                        }
                        // mask &= ~(1 << i)
                        convInfos.push({
                            argIdx: i,
                            method: "pxt::toInt"
                        });
                        return r;
                    }
                    else if (f == "B") {
                        mask &= ~(1 << i);
                        return emitCondition(a, r);
                    }
                    else if (f == "S") {
                        if (!r.isStringLiteral) {
                            convInfos.push({
                                argIdx: i,
                                method: "_pxt_stringConv",
                                returnsRef: true
                            });
                            // set the mask - the result of conversion is a ref
                            mask |= (1 << i);
                        }
                        return r;
                    }
                    else if (f == "F" || f == "D") {
                        if (f == "D")
                            pxtc.U.oops("double arguments not yet supported"); // take two words
                        // TODO disable F on devices with FPU and hard ABI; or maybe altogether
                        // or else, think about using the VFP registers
                        if (!isNumber)
                            pxtc.U.userError("argsFmt=...F/D... but argument not a number in " + name);
                        // mask &= ~(1 << i)
                        convInfos.push({ argIdx: i, method: f == "D" ? "pxt::toDouble" : "pxt::toFloat" });
                        return r;
                    }
                    else {
                        throw pxtc.U.oops("invalid format specifier: " + f);
                    }
                });
                let r = pxtc.ir.rtcallMask(name, mask, attrs ? attrs.callingConvention : 0 /* Plain */, args2);
                if (!r.mask)
                    r.mask = { refMask: 0 };
                r.mask.conversions = convInfos;
                if (opts.target.isNative) {
                    let f0 = fmt[0];
                    if (f0 == "I")
                        r = fromInt(r);
                    else if (f0 == "B")
                        r = fromBool(r);
                    else if (f0 == "F")
                        r = fromFloat(r);
                    else if (f0 == "D") {
                        pxtc.U.oops("double returns not yet supported"); // take two words
                        r = fromDouble(r);
                    }
                }
                return r;
            }
            function emitInJmpValue(expr) {
                let lbl = proc.mkLabel("ldjmp");
                proc.emitJmp(lbl, expr, pxtc.ir.JmpMode.Always);
                proc.emitLbl(lbl);
            }
            function emitInstanceOfExpression(node) {
                let tp = typeOf(node.right);
                let classDecl = isPossiblyGenericClassType(tp) ? getDecl(node.right) : null;
                if (!classDecl || classDecl.kind != pxtc.SK.ClassDeclaration) {
                    userError(9275, lf("unsupported instanceof expression"));
                }
                let info = getClassInfo(tp, classDecl);
                markVTableUsed(info);
                let r = pxtc.ir.op(pxtc.ir.EK.InstanceOf, [emitExpr(node.left)], info);
                r.jsInfo = "bool";
                return r;
            }
            function emitLazyBinaryExpression(node) {
                let left = emitExpr(node.left);
                let isString = isStringType(typeOf(node.left));
                let lbl = proc.mkLabel("lazy");
                left = pxtc.ir.shared(left);
                let cond = pxtc.ir.rtcall("numops::toBool", [left]);
                let lblSkip = proc.mkLabel("lazySkip");
                let mode = node.operatorToken.kind == pxtc.SK.BarBarToken ? pxtc.ir.JmpMode.IfZero :
                    node.operatorToken.kind == pxtc.SK.AmpersandAmpersandToken ? pxtc.ir.JmpMode.IfNotZero :
                        pxtc.U.oops();
                proc.emitJmp(lblSkip, cond, mode);
                proc.emitJmp(lbl, left, pxtc.ir.JmpMode.Always, left);
                proc.emitLbl(lblSkip);
                proc.emitExpr(rtcallMaskDirect("langsupp::ignore", [left]));
                proc.emitJmp(lbl, emitExpr(node.right), pxtc.ir.JmpMode.Always);
                proc.emitLbl(lbl);
                return captureJmpValue();
            }
            function stripEquals(k) {
                switch (k) {
                    case pxtc.SK.PlusEqualsToken: return pxtc.SK.PlusToken;
                    case pxtc.SK.MinusEqualsToken: return pxtc.SK.MinusToken;
                    case pxtc.SK.AsteriskEqualsToken: return pxtc.SK.AsteriskToken;
                    case pxtc.SK.AsteriskAsteriskEqualsToken: return pxtc.SK.AsteriskAsteriskToken;
                    case pxtc.SK.SlashEqualsToken: return pxtc.SK.SlashToken;
                    case pxtc.SK.PercentEqualsToken: return pxtc.SK.PercentToken;
                    case pxtc.SK.LessThanLessThanEqualsToken: return pxtc.SK.LessThanLessThanToken;
                    case pxtc.SK.GreaterThanGreaterThanEqualsToken: return pxtc.SK.GreaterThanGreaterThanToken;
                    case pxtc.SK.GreaterThanGreaterThanGreaterThanEqualsToken: return pxtc.SK.GreaterThanGreaterThanGreaterThanToken;
                    case pxtc.SK.AmpersandEqualsToken: return pxtc.SK.AmpersandToken;
                    case pxtc.SK.BarEqualsToken: return pxtc.SK.BarToken;
                    case pxtc.SK.CaretEqualsToken: return pxtc.SK.CaretToken;
                    default: return pxtc.SK.Unknown;
                }
            }
            function emitBrk(node) {
                bin.numStmts++;
                const needsComment = pxtc.assembler.debug || pxtc.target.switches.size || pxtc.target.sourceMap;
                let needsBreak = !!opts.breakpoints;
                if (!needsComment && !needsBreak)
                    return;
                const src = ts.getSourceFileOfNode(node);
                if (opts.justMyCode && isInPxtModules(src))
                    needsBreak = false;
                if (!needsComment && !needsBreak)
                    return;
                let pos = node.pos;
                while (/^\s$/.exec(src.text[pos]))
                    pos++;
                // a leading comment gets attached to statement
                while (src.text[pos] == '/' && src.text[pos + 1] == '/') {
                    while (src.text[pos] && src.text[pos] != '\n')
                        pos++;
                    pos++;
                }
                const p = ts.getLineAndCharacterOfPosition(src, pos);
                if (needsComment) {
                    let endpos = node.end;
                    if (endpos - pos > 80)
                        endpos = pos + 80;
                    const srctext = src.text.slice(pos, endpos).trim().replace(/\n[^]*/, "...");
                    proc.emit(pxtc.ir.comment(`${src.fileName.replace(/pxt_modules\//, "")}(${p.line + 1},${p.character + 1}): ${srctext}`));
                }
                if (!needsBreak)
                    return;
                const e = ts.getLineAndCharacterOfPosition(src, node.end);
                const brk = {
                    id: res.breakpoints.length,
                    isDebuggerStmt: node.kind == pxtc.SK.DebuggerStatement,
                    fileName: src.fileName,
                    start: pos,
                    length: node.end - pos,
                    line: p.line,
                    endLine: e.line,
                    column: p.character,
                    endColumn: e.character,
                };
                res.breakpoints.push(brk);
                const st = pxtc.ir.stmt(pxtc.ir.SK.Breakpoint, null);
                st.breakpointInfo = brk;
                proc.emit(st);
            }
            function simpleInstruction(node, k) {
                switch (k) {
                    case pxtc.SK.PlusToken: return "numops::adds";
                    case pxtc.SK.MinusToken: return "numops::subs";
                    // we could expose __aeabi_idiv directly...
                    case pxtc.SK.SlashToken: return "numops::div";
                    case pxtc.SK.PercentToken: return "numops::mod";
                    case pxtc.SK.AsteriskToken: return "numops::muls";
                    case pxtc.SK.AsteriskAsteriskToken: return "Math_::pow";
                    case pxtc.SK.AmpersandToken: return "numops::ands";
                    case pxtc.SK.BarToken: return "numops::orrs";
                    case pxtc.SK.CaretToken: return "numops::eors";
                    case pxtc.SK.LessThanLessThanToken: return "numops::lsls";
                    case pxtc.SK.GreaterThanGreaterThanToken: return "numops::asrs";
                    case pxtc.SK.GreaterThanGreaterThanGreaterThanToken: return "numops::lsrs";
                    case pxtc.SK.LessThanEqualsToken: return "numops::le";
                    case pxtc.SK.LessThanToken: return "numops::lt";
                    case pxtc.SK.GreaterThanEqualsToken: return "numops::ge";
                    case pxtc.SK.GreaterThanToken: return "numops::gt";
                    case pxtc.SK.EqualsEqualsToken: return "numops::eq";
                    case pxtc.SK.EqualsEqualsEqualsToken: return "numops::eqq";
                    case pxtc.SK.ExclamationEqualsEqualsToken: return "numops::neqq";
                    case pxtc.SK.ExclamationEqualsToken: return "numops::neq";
                    default: return null;
                }
            }
            function emitBinaryExpression(node) {
                if (node.operatorToken.kind == pxtc.SK.EqualsToken) {
                    return handleAssignment(node);
                }
                const folded = constantFold(node);
                if (folded)
                    return emitLit(folded.val);
                let lt = null;
                let rt = null;
                if (node.operatorToken.kind == pxtc.SK.PlusToken || node.operatorToken.kind == pxtc.SK.PlusEqualsToken) {
                    lt = typeOf(node.left);
                    rt = typeOf(node.right);
                    if (isStringType(lt) || (isStringType(rt) && node.operatorToken.kind == pxtc.SK.PlusToken)) {
                        pxtInfo(node).exprInfo = {
                            leftType: checker.typeToString(lt),
                            rightType: checker.typeToString(rt)
                        };
                    }
                }
                let shim = (n) => {
                    n = mapIntOpName(n);
                    let args = [node.left, node.right];
                    return pxtc.ir.rtcallMask(n, getMask(args), 0 /* Plain */, args.map(x => emitExpr(x)));
                };
                if (node.operatorToken.kind == pxtc.SK.CommaToken) {
                    if (isNoopExpr(node.left))
                        return emitExpr(node.right);
                    else {
                        let v = emitIgnored(node.left);
                        return pxtc.ir.op(EK.Sequence, [v, emitExpr(node.right)]);
                    }
                }
                switch (node.operatorToken.kind) {
                    case pxtc.SK.BarBarToken:
                    case pxtc.SK.AmpersandAmpersandToken:
                        return emitLazyBinaryExpression(node);
                    case pxtc.SK.InstanceOfKeyword:
                        return emitInstanceOfExpression(node);
                }
                if (node.operatorToken.kind == pxtc.SK.PlusToken) {
                    if (isStringType(lt) || isStringType(rt)) {
                        return rtcallMask("String_::concat", [asString(node.left), asString(node.right)], null);
                    }
                }
                if (node.operatorToken.kind == pxtc.SK.PlusEqualsToken && isStringType(lt)) {
                    let cleanup = prepForAssignment(node.left);
                    let post = pxtc.ir.shared(rtcallMask("String_::concat", [asString(node.left), asString(node.right)], null));
                    emitStore(node.left, irToNode(post));
                    cleanup();
                    return post;
                }
                // fallback to numeric operation if none of the argument is string and some are numbers
                let noEq = stripEquals(node.operatorToken.kind);
                let shimName = simpleInstruction(node, noEq || node.operatorToken.kind);
                if (!shimName)
                    unhandled(node.operatorToken, lf("unsupported operator"), 9250);
                if (noEq)
                    return emitIncrement(node.left, shimName, false, node.right);
                return shim(shimName);
            }
            function emitConditionalExpression(node) {
                let els = proc.mkLabel("condexprz");
                let fin = proc.mkLabel("condexprfin");
                proc.emitJmp(els, emitCondition(node.condition), pxtc.ir.JmpMode.IfZero);
                proc.emitJmp(fin, emitExpr(node.whenTrue), pxtc.ir.JmpMode.Always);
                proc.emitLbl(els);
                proc.emitJmp(fin, emitExpr(node.whenFalse), pxtc.ir.JmpMode.Always);
                proc.emitLbl(fin);
                return captureJmpValue();
            }
            function emitSpreadElementExpression(node) { }
            function emitYieldExpression(node) { }
            function emitBlock(node) {
                node.statements.forEach(emit);
            }
            function checkForLetOrConst(declList) {
                if ((declList.flags & ts.NodeFlags.Let) || (declList.flags & ts.NodeFlags.Const)) {
                    return true;
                }
                throw userError(9260, lf("variable needs to be defined using 'let' instead of 'var'"));
            }
            function emitVariableStatement(node) {
                function addConfigEntry(ent) {
                    let entry = pxtc.U.lookup(configEntries, ent.name);
                    if (!entry) {
                        entry = ent;
                        configEntries[ent.name] = entry;
                    }
                    if (entry.value != ent.value)
                        throw userError(9269, lf("conflicting values for config.{0}", ent.name));
                }
                if (node.declarationList.flags & ts.NodeFlags.Const) {
                    let parname = node.parent && node.parent.kind == pxtc.SK.ModuleBlock ?
                        getName(node.parent.parent) : "?";
                    if (parname == "config" || parname == "userconfig")
                        for (let decl of node.declarationList.declarations) {
                            let nm = getDeclName(decl);
                            if (!decl.initializer)
                                continue;
                            let val = emitAsInt(decl.initializer);
                            let key = lookupDalConst(node, "CFG_" + nm);
                            if (key == null || key == 0) // key cannot be 0
                                throw userError(9268, lf("can't find DAL.CFG_{0}", nm));
                            if (parname == "userconfig")
                                nm = "!" + nm;
                            addConfigEntry({ name: nm, key: key, value: val });
                        }
                }
                if (ts.isInAmbientContext(node))
                    return;
                checkForLetOrConst(node.declarationList);
                node.declarationList.declarations.forEach(emit);
            }
            function emitExpressionStatement(node) {
                emitExprAsStmt(node.expression);
            }
            function emitCondition(expr, inner = null) {
                if (!inner && isThumb() && expr.kind == pxtc.SK.BinaryExpression) {
                    let be = expr;
                    let mapped = pxtc.U.lookup(pxtc.thumbCmpMap, simpleInstruction(be, be.operatorToken.kind));
                    if (mapped) {
                        return pxtc.ir.rtcall(mapped, [emitExpr(be.left), emitExpr(be.right)]);
                    }
                }
                if (!inner)
                    inner = emitExpr(expr);
                if (isStackMachine())
                    return inner;
                return pxtc.ir.rtcall("numops::toBoolDecr", [inner]);
            }
            function emitIfStatement(node) {
                emitBrk(node);
                let elseLbl = proc.mkLabel("else");
                proc.emitJmpZ(elseLbl, emitCondition(node.expression));
                emit(node.thenStatement);
                let afterAll = proc.mkLabel("afterif");
                proc.emitJmp(afterAll);
                proc.emitLbl(elseLbl);
                if (node.elseStatement)
                    emit(node.elseStatement);
                proc.emitLbl(afterAll);
            }
            function getLabels(stmt) {
                let id = getNodeId(stmt);
                return {
                    fortop: ".fortop." + id,
                    cont: ".cont." + id,
                    brk: ".brk." + id,
                    ret: ".ret." + id
                };
            }
            function emitDoStatement(node) {
                emitBrk(node);
                let l = getLabels(node);
                proc.emitLblDirect(l.cont);
                emit(node.statement);
                emitBrk(node.expression);
                proc.emitJmpZ(l.brk, emitCondition(node.expression));
                proc.emitJmp(l.cont);
                proc.emitLblDirect(l.brk);
            }
            function emitWhileStatement(node) {
                emitBrk(node);
                let l = getLabels(node);
                proc.emitLblDirect(l.cont);
                emitBrk(node.expression);
                proc.emitJmpZ(l.brk, emitCondition(node.expression));
                emit(node.statement);
                proc.emitJmp(l.cont);
                proc.emitLblDirect(l.brk);
            }
            function isNoopExpr(node) {
                if (!node)
                    return true;
                switch (node.kind) {
                    case pxtc.SK.Identifier:
                    case pxtc.SK.StringLiteral:
                    case pxtc.SK.NumericLiteral:
                    case pxtc.SK.NullKeyword:
                        return true; // no-op
                }
                return false;
            }
            function emitIgnored(node) {
                let v = emitExpr(node);
                return v;
            }
            function emitExprAsStmt(node) {
                if (isNoopExpr(node))
                    return;
                emitBrk(node);
                let v = emitIgnored(node);
                proc.emitExpr(v);
                proc.stackEmpty();
            }
            function emitForStatement(node) {
                if (node.initializer && node.initializer.kind == pxtc.SK.VariableDeclarationList) {
                    checkForLetOrConst(node.initializer);
                    node.initializer.declarations.forEach(emit);
                }
                else {
                    emitExprAsStmt(node.initializer);
                }
                emitBrk(node);
                let l = getLabels(node);
                proc.emitLblDirect(l.fortop);
                if (node.condition) {
                    emitBrk(node.condition);
                    proc.emitJmpZ(l.brk, emitCondition(node.condition));
                }
                emit(node.statement);
                proc.emitLblDirect(l.cont);
                emitExprAsStmt(node.incrementor);
                proc.emitJmp(l.fortop);
                proc.emitLblDirect(l.brk);
            }
            function emitForOfStatement(node) {
                if (!(node.initializer && node.initializer.kind == pxtc.SK.VariableDeclarationList)) {
                    unhandled(node, "only a single variable may be used to iterate a collection");
                    return;
                }
                let declList = node.initializer;
                if (declList.declarations.length != 1) {
                    unhandled(node, "only a single variable may be used to iterate a collection");
                    return;
                }
                checkForLetOrConst(declList);
                //Typecheck the expression being iterated over
                let t = typeOf(node.expression);
                let indexer = "";
                let length = "";
                if (isStringType(t)) {
                    indexer = "String_::charAt";
                    length = "String_::length";
                }
                else if (isArrayType(t)) {
                    indexer = "Array_::getAt";
                    length = "Array_::length";
                }
                else {
                    unhandled(node.expression, "cannot use for...of with this expression");
                    return;
                }
                //As the iterator isn't declared in the usual fashion we must mark it as used, otherwise no cell will be allocated for it
                markUsed(declList.declarations[0]);
                const iterVar = emitVariableDeclaration(declList.declarations[0]); // c
                pxtc.U.assert(!!iterVar || !bin.finalPass);
                proc.stackEmpty();
                // Store the expression (it could be a string literal, for example) for the collection being iterated over
                // Note that it's alaways a ref-counted type
                let collectionVar = proc.mkLocalUnnamed(); // a
                proc.emitExpr(collectionVar.storeByRef(emitExpr(node.expression)));
                // Declaration of iterating variable
                let intVarIter = proc.mkLocalUnnamed(); // i
                proc.emitExpr(intVarIter.storeByRef(emitLit(0)));
                proc.stackEmpty();
                emitBrk(node);
                let l = getLabels(node);
                proc.emitLblDirect(l.fortop);
                // i < a.length()
                // we use loadCore() on collection variable so that it doesn't get incr()ed
                // we could have used load() and rtcallMask to be more regular
                let len = pxtc.ir.rtcall(length, [collectionVar.loadCore()]);
                let cmp = emitIntOp("numops::lt_bool", intVarIter.load(), fromInt(len));
                proc.emitJmpZ(l.brk, cmp);
                // TODO this should be changed to use standard indexer lookup and int handling
                let toInt = (e) => {
                    return needsNumberConversions() ? pxtc.ir.rtcall("pxt::toInt", [e]) : e;
                };
                // c = a[i]
                if (iterVar) {
                    proc.emitExpr(iterVar.storeByRef(pxtc.ir.rtcall(indexer, [collectionVar.loadCore(), toInt(intVarIter.loadCore())])));
                    emitBrk(node.initializer);
                }
                flushHoistedFunctionDefinitions();
                emit(node.statement);
                proc.emitLblDirect(l.cont);
                // i = i + 1
                proc.emitExpr(intVarIter.storeByRef(emitIntOp("numops::adds", intVarIter.load(), emitLit(1))));
                proc.emitJmp(l.fortop);
                proc.emitLblDirect(l.brk);
                proc.emitExpr(collectionVar.storeByRef(emitLit(undefined))); // clear it, so it gets GCed
            }
            function emitForInOrForOfStatement(node) { }
            function emitBreakOrContinueStatement(node) {
                emitBrk(node);
                let label = node.label ? node.label.text : null;
                let isBreak = node.kind == pxtc.SK.BreakStatement;
                let numTry = 0;
                function findOuter(parent) {
                    if (!parent)
                        return null;
                    if (label && parent.kind == pxtc.SK.LabeledStatement &&
                        parent.label.text == label)
                        return parent.statement;
                    if (parent.kind == pxtc.SK.SwitchStatement && !label && isBreak)
                        return parent;
                    if (!label && ts.isIterationStatement(parent, false))
                        return parent;
                    numTry += numBeginTry(parent);
                    return findOuter(parent.parent);
                }
                let stmt = findOuter(node);
                if (!stmt)
                    error(node, 9230, lf("cannot find outer loop"));
                else {
                    let l = getLabels(stmt);
                    emitEndTry(numTry);
                    if (node.kind == pxtc.SK.ContinueStatement) {
                        if (!ts.isIterationStatement(stmt, false))
                            error(node, 9231, lf("continue on non-loop"));
                        else
                            proc.emitJmp(l.cont);
                    }
                    else if (node.kind == pxtc.SK.BreakStatement) {
                        proc.emitJmp(l.brk);
                    }
                    else {
                        pxtc.oops();
                    }
                }
            }
            function emitReturnStatement(node) {
                emitBrk(node);
                let v = null;
                if (node.expression) {
                    v = emitExpr(node.expression);
                }
                else if (funcHasReturn(proc.action)) {
                    v = emitLit(undefined); // == return undefined
                }
                let numTry = 0;
                for (let p = node; p; p = p.parent) {
                    if (p == proc.action)
                        break;
                    numTry += numBeginTry(p);
                }
                emitEndTry(numTry);
                proc.emitJmp(getLabels(proc.action).ret, v, pxtc.ir.JmpMode.Always);
            }
            function emitWithStatement(node) { }
            function emitSwitchStatement(node) {
                emitBrk(node);
                let l = getLabels(node);
                let defaultLabel;
                let expr = pxtc.ir.shared(emitExpr(node.expression));
                let lbls = node.caseBlock.clauses.map(cl => {
                    let lbl = proc.mkLabel("switch");
                    if (cl.kind == pxtc.SK.CaseClause) {
                        let cc = cl;
                        let cmpExpr = emitExpr(cc.expression);
                        let mask = isRefCountedExpr(cc.expression) ? 1 : 0;
                        // we assume the value we're switching over will stay alive
                        // so, the mask only applies to the case expression if needed
                        // switch_eq() will decr(expr) if result is true
                        let cmpCall = pxtc.ir.rtcallMask(mapIntOpName("pxt::switch_eq"), mask, 0 /* Plain */, [cmpExpr, expr]);
                        proc.emitJmp(lbl, cmpCall, pxtc.ir.JmpMode.IfNotZero, expr);
                    }
                    else if (cl.kind == pxtc.SK.DefaultClause) {
                        // Save default label for emit at the end of the
                        // tests section. Default label doesn't have to come at the
                        // end in JS.
                        pxtc.assert(!defaultLabel, "!defaultLabel");
                        defaultLabel = lbl;
                    }
                    else {
                        pxtc.oops();
                    }
                    return lbl;
                });
                if (defaultLabel)
                    proc.emitJmp(defaultLabel, expr);
                else
                    proc.emitJmp(l.brk, expr);
                node.caseBlock.clauses.forEach((cl, i) => {
                    proc.emitLbl(lbls[i]);
                    cl.statements.forEach(emit);
                });
                proc.emitLblDirect(l.brk);
            }
            function emitCaseOrDefaultClause(node) { }
            function emitLabeledStatement(node) {
                let l = getLabels(node.statement);
                emit(node.statement);
                proc.emitLblDirect(l.brk);
            }
            function emitThrowStatement(node) {
                emitBrk(node);
                proc.emitExpr(rtcallMaskDirect("pxt::throwValue", [emitExpr(node.expression)]));
            }
            function emitEndTry(num = 1) {
                while (num--) {
                    proc.emitExpr(rtcallMaskDirect("pxt::endTry", []));
                }
            }
            function jumpXFinally() {
                userError(9282, lf("jumps (return, break, continue) through finally blocks not supported yet"));
            }
            function numBeginTry(node) {
                let r = 0;
                if (node.kind == ts.SyntaxKind.Block && node.parent) {
                    if (node.parent.kind == ts.SyntaxKind.CatchClause) {
                        // from inside of catch there's at most the finally block to close
                        const t = node.parent.parent;
                        if (t.finallyBlock) {
                            r++;
                            jumpXFinally();
                        }
                    }
                    else if (node.parent.kind == ts.SyntaxKind.TryStatement) {
                        // from inside of the body of try{} there possibly the catch and finally blocks to close
                        const t = node.parent;
                        if (t.tryBlock == node) {
                            if (t.catchClause)
                                r++;
                            if (t.finallyBlock) {
                                r++;
                                jumpXFinally();
                            }
                        }
                    }
                    else {
                        // if we're inside of finally there's nothing to close already
                        // (or more common this block has nothing to do with try{})
                    }
                }
                return r;
            }
            function emitTryStatement(node) {
                const beginTry = (lbl) => rtcallMaskDirect("pxt::beginTry", [pxtc.ir.ptrlit(lbl.lblName, lbl)]);
                emitBrk(node);
                const lcatch = proc.mkLabel("catch");
                lcatch.lblName = "_catch_" + getNodeId(node);
                const lfinally = proc.mkLabel("finally");
                lfinally.lblName = "_finally_" + getNodeId(node);
                if (node.finallyBlock)
                    proc.emitExpr(beginTry(lfinally));
                if (node.catchClause)
                    proc.emitExpr(beginTry(lcatch));
                proc.stackEmpty();
                emitBlock(node.tryBlock);
                proc.stackEmpty();
                if (node.catchClause) {
                    const skip = proc.mkLabel("catchend");
                    emitEndTry();
                    proc.emitJmp(skip);
                    proc.emitLbl(lcatch);
                    const decl = node.catchClause.variableDeclaration;
                    if (decl) {
                        emitVariableDeclaration(decl);
                        const loc = lookupCell(decl);
                        proc.emitExpr(loc.storeByRef(rtcallMaskDirect("pxt::getThrownValue", [])));
                    }
                    flushHoistedFunctionDefinitions();
                    emitBlock(node.catchClause.block);
                    proc.emitLbl(skip);
                }
                if (node.finallyBlock) {
                    emitEndTry();
                    proc.emitLbl(lfinally);
                    emitBlock(node.finallyBlock);
                    proc.emitExpr(rtcallMaskDirect("pxt::endFinally", []));
                }
            }
            function emitCatchClause(node) { }
            function emitDebuggerStatement(node) {
                emitBrk(node);
            }
            function isLoop(node) {
                switch (node.kind) {
                    case pxtc.SK.WhileStatement:
                    case pxtc.SK.ForInStatement:
                    case pxtc.SK.ForOfStatement:
                    case pxtc.SK.ForStatement:
                    case pxtc.SK.DoStatement:
                        return true;
                    default:
                        return false;
                }
            }
            function inLoop(node) {
                while (node) {
                    if (isLoop(node))
                        return true;
                    node = node.parent;
                }
                return false;
            }
            function emitVarOrParam(node, bindingExpr, bindingType) {
                if (node.name.kind === pxtc.SK.ObjectBindingPattern || node.name.kind == pxtc.SK.ArrayBindingPattern) {
                    if (!bindingExpr) {
                        bindingExpr = node.initializer ? pxtc.ir.shared(emitExpr(node.initializer)) :
                            emitLocalLoad(node);
                        bindingType = node.initializer ? typeOf(node.initializer) : typeOf(node);
                    }
                    node.name.elements.forEach((e) => emitVarOrParam(e, bindingExpr, bindingType));
                    proc.stackEmpty(); // stack empty only after all assigned
                    return null;
                }
                if (!shouldEmitNow(node)) {
                    return null;
                }
                // skip emit of things, where access to them is emitted as literal
                if (constantFoldDecl(node))
                    return null;
                let loc;
                if (isGlobalVar(node)) {
                    emitGlobal(node);
                    loc = lookupCell(node);
                }
                else {
                    loc = proc.mkLocal(node, getVarInfo(node));
                }
                markVariableDefinition(loc.info);
                if (loc.isByRefLocal()) {
                    proc.emitExpr(loc.storeDirect(pxtc.ir.rtcall("pxtrt::mklocRef", [])));
                }
                typeCheckVar(typeOf(node));
                if (node.kind === pxtc.SK.BindingElement) {
                    emitBrk(node);
                    let [expr, tp] = bindingElementAccessExpression(node, bindingExpr, bindingType);
                    proc.emitExpr(loc.storeByRef(expr));
                }
                else if (node.initializer) {
                    emitBrk(node);
                    if (isGlobalVar(node)) {
                        let attrs = parseComments(node);
                        let jrname = attrs.jres;
                        if (jrname) {
                            if (jrname == "true") {
                                jrname = getNodeFullName(checker, node);
                            }
                            let jr = pxtc.U.lookup(opts.jres || {}, jrname);
                            if (!jr) {
                                userError(9270, lf("resource '{0}' not found in any .jres file", jrname));
                            }
                            else {
                                currJres = jr;
                            }
                        }
                    }
                    typeCheckSubtoSup(node.initializer, node);
                    proc.emitExpr(loc.storeByRef(emitExpr(node.initializer)));
                    currJres = null;
                    proc.stackEmpty();
                }
                else if (inLoop(node)) {
                    // the variable is declared in a loop - we need to clear it on each iteration
                    emitBrk(node);
                    proc.emitExpr(loc.storeByRef(emitLit(undefined)));
                    proc.stackEmpty();
                }
                return loc;
            }
            function emitVariableDeclaration(node) {
                return emitVarOrParam(node, null, null);
            }
            function emitFieldAccess(node, objRef, objType, fieldName) {
                const fieldSym = checker.getPropertyOfType(objType, fieldName);
                pxtc.U.assert(!!fieldSym, "field sym");
                const myType = checker.getTypeOfSymbolAtLocation(fieldSym, node);
                let exres;
                if (isPossiblyGenericClassType(objType)) {
                    const info = getClassInfo(objType);
                    exres = pxtc.ir.op(EK.FieldAccess, [objRef], fieldIndexCore(info, getFieldInfo(info, fieldName)));
                }
                else {
                    exres = mkMethodCall([objRef], {
                        ifaceIndex: getIfaceMemberId(fieldName, true),
                        callLocationIndex: markCallLocation(node),
                        noArgs: true
                    });
                }
                return [exres, myType];
            }
            function bindingElementAccessExpression(bindingElement, parentAccess, parentType) {
                const target = bindingElement.parent.parent;
                if (target.kind === pxtc.SK.BindingElement) {
                    const parent = bindingElementAccessExpression(target, parentAccess, parentType);
                    parentAccess = parent[0];
                    parentType = parent[1];
                }
                if (bindingElement.parent.kind == pxtc.SK.ArrayBindingPattern) {
                    const idx = bindingElement.parent.elements.indexOf(bindingElement);
                    if (bindingElement.dotDotDotToken)
                        userError(9203, lf("spread operator not supported yet"));
                    const myType = arrayElementType(parentType, idx);
                    return [
                        rtcallMaskDirect("Array_::getAt", [parentAccess, pxtc.ir.numlit(idx)]),
                        myType
                    ];
                }
                else {
                    const propertyName = (bindingElement.propertyName || bindingElement.name);
                    return emitFieldAccess(bindingElement, parentAccess, parentType, propertyName.text);
                }
            }
            function emitClassDeclaration(node) {
                const info = getClassInfo(null, node);
                if (info.isUsed && bin.usedClassInfos.indexOf(info) < 0) {
                    // U.assert(!bin.finalPass)
                    bin.usedClassInfos.push(info);
                }
                node.members.forEach(emit);
            }
            function emitInterfaceDeclaration(node) {
                checkInterfaceDeclaration(bin, node);
                let attrs = parseComments(node);
                if (attrs.autoCreate)
                    autoCreateFunctions[attrs.autoCreate] = true;
            }
            function emitEnumDeclaration(node) {
                //No code needs to be generated, enum names are replaced by constant values in generated code
            }
            function emitEnumMember(node) { }
            function emitModuleDeclaration(node) {
                emit(node.body);
            }
            function emitImportDeclaration(node) { }
            function emitImportEqualsDeclaration(node) { }
            function emitExportDeclaration(node) { }
            function emitExportAssignment(node) { }
            function emitSourceFileNode(node) {
                node.statements.forEach(emit);
            }
            function catchErrors(node, f) {
                let prevErr = lastSecondaryError;
                inCatchErrors++;
                try {
                    lastSecondaryError = null;
                    let res = f(node);
                    if (lastSecondaryError)
                        userError(lastSecondaryErrorCode, lastSecondaryError);
                    lastSecondaryError = prevErr;
                    inCatchErrors--;
                    return res;
                }
                catch (e) {
                    inCatchErrors--;
                    lastSecondaryError = null;
                    // if (!e.ksEmitterUserError)
                    let code = e.ksErrorCode || 9200;
                    error(node, code, e.message);
                    pxt.debug(e.stack);
                    return null;
                }
            }
            function emitExpr(node0, useCache = true) {
                let node = node0;
                if (useCache && node.cachedIR) {
                    return node.cachedIR;
                }
                let res = catchErrors(node, emitExprInner) || emitLit(undefined);
                if (useCache && node.needsIRCache) {
                    node.cachedIR = pxtc.ir.shared(res);
                    return node.cachedIR;
                }
                return res;
            }
            function emitExprInner(node) {
                let expr = emitExprCore(node);
                if (expr.isExpr())
                    return expr;
                throw new Error("expecting expression");
            }
            function emitTopLevel(node) {
                const pinfo = pxtInfo(node);
                if (pinfo.usedNodes) {
                    needsUsingInfo = false;
                    for (let node of pxtc.U.values(pinfo.usedNodes))
                        markUsed(node);
                    for (let fn of pinfo.usedActions)
                        fn(bin);
                    needsUsingInfo = true;
                }
                else if (isGlobalVar(node) || ts.isClassDeclaration(node)) {
                    needsUsingInfo = false;
                    currUsingContext = pinfo;
                    currUsingContext.usedNodes = null;
                    currUsingContext.usedActions = null;
                    if (isGlobalVar(node) && !constantFoldDecl(node))
                        emitGlobal(node);
                    emit(node);
                    needsUsingInfo = true;
                }
                else {
                    currUsingContext = pinfo;
                    currUsingContext.usedNodes = {};
                    currUsingContext.usedActions = [];
                    emit(node);
                    currUsingContext = null;
                }
            }
            function emit(node) {
                catchErrors(node, emitNodeCore);
            }
            function emitNodeCore(node) {
                switch (node.kind) {
                    case pxtc.SK.SourceFile:
                        return emitSourceFileNode(node);
                    case pxtc.SK.InterfaceDeclaration:
                        return emitInterfaceDeclaration(node);
                    case pxtc.SK.VariableStatement:
                        return emitVariableStatement(node);
                    case pxtc.SK.ModuleDeclaration:
                        return emitModuleDeclaration(node);
                    case pxtc.SK.EnumDeclaration:
                        return emitEnumDeclaration(node);
                    //case SyntaxKind.MethodSignature:
                    case pxtc.SK.FunctionDeclaration:
                    case pxtc.SK.Constructor:
                    case pxtc.SK.MethodDeclaration:
                        emitFunctionDeclaration(node);
                        return;
                    case pxtc.SK.ExpressionStatement:
                        return emitExpressionStatement(node);
                    case pxtc.SK.Block:
                    case pxtc.SK.ModuleBlock:
                        return emitBlock(node);
                    case pxtc.SK.VariableDeclaration:
                        emitVariableDeclaration(node);
                        flushHoistedFunctionDefinitions();
                        return;
                    case pxtc.SK.IfStatement:
                        return emitIfStatement(node);
                    case pxtc.SK.WhileStatement:
                        return emitWhileStatement(node);
                    case pxtc.SK.DoStatement:
                        return emitDoStatement(node);
                    case pxtc.SK.ForStatement:
                        return emitForStatement(node);
                    case pxtc.SK.ForOfStatement:
                        return emitForOfStatement(node);
                    case pxtc.SK.ContinueStatement:
                    case pxtc.SK.BreakStatement:
                        return emitBreakOrContinueStatement(node);
                    case pxtc.SK.LabeledStatement:
                        return emitLabeledStatement(node);
                    case pxtc.SK.ReturnStatement:
                        return emitReturnStatement(node);
                    case pxtc.SK.ClassDeclaration:
                        return emitClassDeclaration(node);
                    case pxtc.SK.PropertyDeclaration:
                    case pxtc.SK.PropertyAssignment:
                        return emitPropertyAssignment(node);
                    case pxtc.SK.SwitchStatement:
                        return emitSwitchStatement(node);
                    case pxtc.SK.TypeAliasDeclaration:
                        // skip
                        return;
                    case ts.SyntaxKind.TryStatement:
                        return emitTryStatement(node);
                    case ts.SyntaxKind.ThrowStatement:
                        return emitThrowStatement(node);
                    case pxtc.SK.DebuggerStatement:
                        return emitDebuggerStatement(node);
                    case pxtc.SK.GetAccessor:
                    case pxtc.SK.SetAccessor:
                        return emitAccessor(node);
                    case pxtc.SK.ImportEqualsDeclaration:
                        // this doesn't do anything in compiled code
                        return emitImportEqualsDeclaration(node);
                    case pxtc.SK.EmptyStatement:
                        return;
                    case pxtc.SK.SemicolonClassElement:
                        return;
                    default:
                        unhandled(node);
                }
            }
            function emitExprCore(node) {
                switch (node.kind) {
                    case pxtc.SK.NullKeyword:
                        let v = pxtInfo(node).valueOverride;
                        if (v)
                            return v;
                        return emitLit(null);
                    case pxtc.SK.TrueKeyword:
                        return emitLit(true);
                    case pxtc.SK.FalseKeyword:
                        return emitLit(false);
                    case pxtc.SK.TemplateHead:
                    case pxtc.SK.TemplateMiddle:
                    case pxtc.SK.TemplateTail:
                    case pxtc.SK.NumericLiteral:
                    case pxtc.SK.StringLiteral:
                    case pxtc.SK.NoSubstitutionTemplateLiteral:
                        //case SyntaxKind.RegularExpressionLiteral:
                        return emitLiteral(node);
                    case pxtc.SK.TaggedTemplateExpression:
                        return emitTaggedTemplateExpression(node);
                    case pxtc.SK.PropertyAccessExpression:
                        return emitPropertyAccess(node);
                    case pxtc.SK.BinaryExpression:
                        return emitBinaryExpression(node);
                    case pxtc.SK.PrefixUnaryExpression:
                        return emitPrefixUnaryExpression(node);
                    case pxtc.SK.PostfixUnaryExpression:
                        return emitPostfixUnaryExpression(node);
                    case pxtc.SK.ElementAccessExpression:
                        return emitIndexedAccess(node);
                    case pxtc.SK.ParenthesizedExpression:
                        return emitParenExpression(node);
                    case pxtc.SK.TypeAssertionExpression:
                        return emitTypeAssertion(node);
                    case pxtc.SK.ArrayLiteralExpression:
                        return emitArrayLiteral(node);
                    case pxtc.SK.NewExpression:
                        return emitNewExpression(node);
                    case pxtc.SK.SuperKeyword:
                    case pxtc.SK.ThisKeyword:
                        return emitThis(node);
                    case pxtc.SK.CallExpression:
                        return emitCallExpression(node);
                    case pxtc.SK.FunctionExpression:
                    case pxtc.SK.ArrowFunction:
                        return emitFunctionDeclaration(node);
                    case pxtc.SK.Identifier:
                        return emitIdentifier(node);
                    case pxtc.SK.ConditionalExpression:
                        return emitConditionalExpression(node);
                    case pxtc.SK.AsExpression:
                        return emitAsExpression(node);
                    case pxtc.SK.TemplateExpression:
                        return emitTemplateExpression(node);
                    case pxtc.SK.ObjectLiteralExpression:
                        return emitObjectLiteral(node);
                    case pxtc.SK.TypeOfExpression:
                        return emitTypeOfExpression(node);
                    case ts.SyntaxKind.DeleteExpression:
                        return emitDeleteExpression(node);
                    default:
                        unhandled(node);
                        return null;
                    /*
                    case SyntaxKind.TemplateSpan:
                        return emitTemplateSpan(<TemplateSpan>node);
                    case SyntaxKind.Parameter:
                        return emitParameter(<ParameterDeclaration>node);
                    case SyntaxKind.SuperKeyword:
                        return emitSuper(node);
                    case SyntaxKind.JsxElement:
                        return emitJsxElement(<JsxElement>node);
                    case SyntaxKind.JsxSelfClosingElement:
                        return emitJsxSelfClosingElement(<JsxSelfClosingElement>node);
                    case SyntaxKind.JsxText:
                        return emitJsxText(<JsxText>node);
                    case SyntaxKind.JsxExpression:
                        return emitJsxExpression(<JsxExpression>node);
                    case SyntaxKind.QualifiedName:
                        return emitQualifiedName(<QualifiedName>node);
                    case SyntaxKind.ObjectBindingPattern:
                        return emitObjectBindingPattern(<BindingPattern>node);
                    case SyntaxKind.ArrayBindingPattern:
                        return emitArrayBindingPattern(<BindingPattern>node);
                    case SyntaxKind.BindingElement:
                        return emitBindingElement(<BindingElement>node);
                    case SyntaxKind.ShorthandPropertyAssignment:
                        return emitShorthandPropertyAssignment(<ShorthandPropertyAssignment>node);
                    case SyntaxKind.ComputedPropertyName:
                        return emitComputedPropertyName(<ComputedPropertyName>node);
                    case SyntaxKind.TaggedTemplateExpression:
                        return emitTaggedTemplateExpression(<TaggedTemplateExpression>node);
                    case SyntaxKind.VoidExpression:
                        return emitVoidExpression(<VoidExpression>node);
                    case SyntaxKind.AwaitExpression:
                        return emitAwaitExpression(<AwaitExpression>node);
                    case SyntaxKind.SpreadElementExpression:
                        return emitSpreadElementExpression(<SpreadElementExpression>node);
                    case SyntaxKind.YieldExpression:
                        return emitYieldExpression(<YieldExpression>node);
                    case SyntaxKind.OmittedExpression:
                        return;
                    case SyntaxKind.EmptyStatement:
                        return;
                    case SyntaxKind.ForOfStatement:
                    case SyntaxKind.ForInStatement:
                        return emitForInOrForOfStatement(<ForInStatement>node);
                    case SyntaxKind.WithStatement:
                        return emitWithStatement(<WithStatement>node);
                    case SyntaxKind.CaseClause:
                    case SyntaxKind.DefaultClause:
                        return emitCaseOrDefaultClause(<CaseOrDefaultClause>node);
                    case SyntaxKind.CatchClause:
                        return emitCatchClause(<CatchClause>node);
                    case SyntaxKind.ClassExpression:
                        return emitClassExpression(<ClassExpression>node);
                    case SyntaxKind.EnumMember:
                        return emitEnumMember(<EnumMember>node);
                    case SyntaxKind.ImportDeclaration:
                        return emitImportDeclaration(<ImportDeclaration>node);
                    case SyntaxKind.ExportDeclaration:
                        return emitExportDeclaration(<ExportDeclaration>node);
                    case SyntaxKind.ExportAssignment:
                        return emitExportAssignment(<ExportAssignment>node);
                    */
                }
            }
            function markCallLocation(node) {
                return res.procCallLocations.push(pxtc.nodeLocationInfo(node)) - 1;
            }
        }
        pxtc.compileBinary = compileBinary;
        function doubleToBits(v) {
            let a = new Float64Array(1);
            a[0] = v;
            return pxtc.U.toHex(new Uint8Array(a.buffer));
        }
        function floatToBits(v) {
            let a = new Float32Array(1);
            a[0] = v;
            return pxtc.U.toHex(new Uint8Array(a.buffer));
        }
        function checkPrimitiveType(t, flags, tp) {
            if (t.flags & flags) {
                return true;
            }
            return checkUnionOfLiterals(t) === tp;
        }
        function isStringType(t) {
            return checkPrimitiveType(t, ts.TypeFlags.String | ts.TypeFlags.StringLiteral, HasLiteralType.String);
        }
        pxtc.isStringType = isStringType;
        function isNumberType(t) {
            return checkPrimitiveType(t, ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral, HasLiteralType.Number);
        }
        function isBooleanType(t) {
            return checkPrimitiveType(t, ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral, HasLiteralType.Boolean);
        }
        function isEnumType(t) {
            return checkPrimitiveType(t, ts.TypeFlags.Enum | ts.TypeFlags.EnumLiteral, HasLiteralType.Enum);
        }
        function isNumericalType(t) {
            return isEnumType(t) || isNumberType(t);
        }
        class Binary {
            constructor() {
                this.procs = [];
                this.globals = [];
                this.finalPass = false;
                this.writeFile = (fn, cont) => { };
                this.usedClassInfos = [];
                this.numStmts = 1;
                this.commSize = 0;
                this.itEntries = 0;
                this.itFullEntries = 0;
                this.numMethods = 0;
                this.numVirtMethods = 0;
                this.usedChars = new Uint32Array(0x10000 / 32);
                this.explicitlyUsedIfaceMembers = {};
                this.ifaceMemberMap = {};
                this.strings = {};
                this.hexlits = {};
                this.doubles = {};
                this.otherLiterals = [];
                this.codeHelpers = {};
                this.lblNo = 0;
            }
            reset() {
                this.lblNo = 0;
                this.otherLiterals = [];
                this.strings = {};
                this.hexlits = {};
                this.doubles = {};
                this.numStmts = 0;
            }
            getTitle() {
                const title = this.options.name || pxtc.U.lf("Untitled");
                if (title.length >= 90)
                    return title.slice(0, 87) + "...";
                else
                    return title;
            }
            addProc(proc) {
                pxtc.assert(!this.finalPass, "!this.finalPass");
                this.procs.push(proc);
                proc.seqNo = this.procs.length;
                //proc.binary = this
            }
            recordHelper(usingCtx, id, gen) {
                const act = (bin) => {
                    if (!bin.codeHelpers[id])
                        bin.codeHelpers[id] = gen(bin);
                };
                act(this);
                this.recordAction(usingCtx, act);
            }
            recordAction(usingCtx, f) {
                if (usingCtx) {
                    if (usingCtx.usedActions)
                        usingCtx.usedActions.push(f);
                }
                else
                    pxtc.U.oops("no using ctx!");
            }
            emitLabelled(v, hash, lblpref) {
                let r = pxtc.U.lookup(hash, v);
                if (r != null)
                    return r;
                let lbl = lblpref + this.lblNo++;
                hash[v] = lbl;
                return lbl;
            }
            emitDouble(v) {
                return this.emitLabelled(pxtc.target.switches.numFloat ? floatToBits(v) : doubleToBits(v), this.doubles, "_dbl");
            }
            emitString(s) {
                if (!this.finalPass)
                    for (let i = 0; i < s.length; ++i) {
                        const ch = s.charCodeAt(i);
                        if (ch >= 128)
                            this.usedChars[ch >> 5] |= 1 << (ch & 31);
                    }
                return this.emitLabelled(s, this.strings, "_str");
            }
            emitHexLiteral(s) {
                return this.emitLabelled(s, this.hexlits, "_hexlit");
            }
            setPerfCounters(systemPerfCounters) {
                if (!pxtc.target.switches.profile)
                    return [];
                const perfCounters = systemPerfCounters.slice();
                this.procs.forEach(p => {
                    if (p.perfCounterName) {
                        pxtc.U.assert(pxtc.target.switches.profile);
                        p.perfCounterNo = perfCounters.length;
                        perfCounters.push(p.perfCounterName);
                    }
                });
                return perfCounters;
            }
        }
        pxtc.Binary = Binary;
        function isCtorField(p) {
            if (!p.modifiers)
                return false;
            if (p.parent.kind != pxtc.SK.Constructor)
                return false;
            for (let m of p.modifiers) {
                if (m.kind == pxtc.SK.PrivateKeyword ||
                    m.kind == pxtc.SK.PublicKeyword ||
                    m.kind == pxtc.SK.ProtectedKeyword)
                    return true;
            }
            return false;
        }
        pxtc.isCtorField = isCtorField;
        function isNumberLikeType(type) {
            if (type.flags & ts.TypeFlags.Union) {
                return type.types.every(t => isNumberLikeType(t));
            }
            else {
                return !!(type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.EnumLike | ts.TypeFlags.BooleanLike));
            }
        }
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
/// <reference path="../../localtypings/pxtarget.d.ts"/>
// TODO: enable reference so we don't need to use: (pxt as any).py
//      the issue is that this creates a circular dependency. This
//      is easily handled if we used proper TS modules.
//// <reference path="../../built/pxtpy.d.ts"/>
// Enforce order:
/// <reference path="thumb.ts"/>
/// <reference path="ir.ts"/>
/// <reference path="emitter.ts"/>
/// <reference path="backthumb.ts"/>
/// <reference path="decompiler.ts"/>
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        function getTsCompilerOptions(opts) {
            let options = ts.getDefaultCompilerOptions();
            options.target = ts.ScriptTarget.ES5;
            options.module = ts.ModuleKind.None;
            options.noImplicitAny = true;
            options.noImplicitReturns = true;
            options.allowUnreachableCode = true;
            return options;
        }
        pxtc.getTsCompilerOptions = getTsCompilerOptions;
        function nodeLocationInfo(node) {
            let file = ts.getSourceFileOfNode(node);
            const nodeStart = node.getStart ? node.getStart() : node.pos;
            const { line, character } = ts.getLineAndCharacterOfPosition(file, nodeStart);
            const { line: endLine, character: endChar } = ts.getLineAndCharacterOfPosition(file, node.end);
            let r = {
                start: nodeStart,
                length: node.end - nodeStart,
                line: line,
                column: character,
                endLine: endLine,
                endColumn: endChar,
                fileName: file.fileName,
            };
            return r;
        }
        pxtc.nodeLocationInfo = nodeLocationInfo;
        function patchUpDiagnostics(diags, ignoreFileResolutionErorrs = false) {
            if (ignoreFileResolutionErorrs) {
                // Because we generate the program and the virtual file system, we can safely ignore
                // file resolution errors. They are generated by triple slash references that likely
                // have a different path format than the one our dumb file system expects. The files
                // are included, our compiler host just isn't smart enough to resolve them.
                diags = diags.filter(d => d.code !== 5012);
            }
            let highPri = diags.filter(d => d.code == 1148);
            if (highPri.length > 0)
                diags = highPri;
            return diags.map(d => {
                if (!d.file) {
                    let rr = {
                        code: d.code,
                        start: d.start,
                        length: d.length,
                        line: 0,
                        column: 0,
                        messageText: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
                        category: d.category,
                        fileName: "?",
                    };
                    return rr;
                }
                const pos = ts.getLineAndCharacterOfPosition(d.file, d.start);
                let r = {
                    code: d.code,
                    start: d.start,
                    length: d.length,
                    line: pos.line,
                    column: pos.character,
                    messageText: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
                    category: d.category,
                    fileName: d.file.fileName,
                };
                if (r.code == 1148)
                    r.messageText = pxtc.Util.lf("all symbols in top-level scope are always exported; please use a namespace if you want to export only some");
                return r;
            });
        }
        pxtc.patchUpDiagnostics = patchUpDiagnostics;
        function py2tsIfNecessary(opts) {
            if (opts.target.preferredEditor == pxt.PYTHON_PROJECT_NAME) {
                let res = pxtc.transpile.pyToTs(opts);
                return res;
            }
            return undefined;
        }
        pxtc.py2tsIfNecessary = py2tsIfNecessary;
        function mkCompileResult() {
            return {
                outfiles: {},
                diagnostics: [],
                success: false,
                times: {},
            };
        }
        function storeGeneratedFiles(opts, res) {
            // save files first, in case we generated some .ts files that fail to compile
            for (let f of opts.generatedFiles || [])
                res.outfiles[f] = opts.fileSystem[f];
        }
        pxtc.storeGeneratedFiles = storeGeneratedFiles;
        function runConversionsAndStoreResults(opts, res) {
            const startTime = pxtc.U.cpuUs();
            if (!res) {
                res = mkCompileResult();
            }
            const convRes = py2tsIfNecessary(opts);
            if (convRes) {
                res = Object.assign(Object.assign({}, res), { diagnostics: convRes.diagnostics, sourceMap: convRes.sourceMap, globalNames: convRes.globalNames });
            }
            storeGeneratedFiles(opts, res);
            if (!opts.sourceFiles)
                opts.sourceFiles = Object.keys(opts.fileSystem);
            // ensure that main.ts is last of TS files
            const idx = opts.sourceFiles.indexOf(pxt.MAIN_TS);
            if (idx >= 0) {
                opts.sourceFiles.splice(idx, 1);
                opts.sourceFiles.push(pxt.MAIN_TS);
            }
            // run post-processing code last, if present
            const postIdx = opts.sourceFiles.indexOf(pxt.TUTORIAL_CODE_STOP);
            if (postIdx >= 0) {
                opts.sourceFiles.splice(postIdx, 1);
                opts.sourceFiles.push(pxt.TUTORIAL_CODE_STOP);
            }
            res.times["conversions"] = pxtc.U.cpuUs() - startTime;
            return res;
        }
        pxtc.runConversionsAndStoreResults = runConversionsAndStoreResults;
        function timesToMs(res) {
            for (let k of Object.keys(res.times)) {
                res.times[k] = Math.round(res.times[k]) / 1000;
            }
        }
        pxtc.timesToMs = timesToMs;
        function buildProgram(opts, res) {
            let fileText = {};
            for (let fileName in opts.fileSystem) {
                fileText[normalizePath(fileName)] = opts.fileSystem[fileName];
            }
            let setParentNodes = true;
            let options = getTsCompilerOptions(opts);
            let host = {
                getSourceFile: (fn, v, err) => {
                    fn = normalizePath(fn);
                    let text = "";
                    if (fileText.hasOwnProperty(fn)) {
                        text = fileText[fn];
                    }
                    else {
                        if (err)
                            err("File not found: " + fn);
                    }
                    if (text == null) {
                        err("File not found: " + fn);
                        text = "";
                    }
                    return ts.createSourceFile(fn, text, v, setParentNodes);
                },
                fileExists: fn => {
                    fn = normalizePath(fn);
                    return fileText.hasOwnProperty(fn);
                },
                getCanonicalFileName: fn => fn,
                getDefaultLibFileName: () => "no-default-lib.d.ts",
                writeFile: (fileName, data, writeByteOrderMark, onError) => {
                    res.outfiles[fileName] = data;
                },
                getCurrentDirectory: () => ".",
                useCaseSensitiveFileNames: () => true,
                getNewLine: () => "\n",
                readFile: fn => {
                    fn = normalizePath(fn);
                    return fileText[fn] || "";
                },
                directoryExists: dn => true,
                getDirectories: () => []
            };
            let tsFiles = opts.sourceFiles.filter(f => pxtc.U.endsWith(f, ".ts"));
            return ts.createProgram(tsFiles, options, host);
        }
        function isPxtModulesFilename(filename) {
            return pxtc.U.startsWith(filename, "pxt_modules/");
        }
        pxtc.isPxtModulesFilename = isPxtModulesFilename;
        function compile(opts, service) {
            if (!pxtc.compilerHooks) {
                // run the extension at most once
                pxtc.compilerHooks = {};
                // The extension JavaScript code comes from target.json. It is generated from compiler/*.ts in target by 'pxt buildtarget'
                if (opts.target.compilerExtension)
                    // eslint-disable-next-line
                    eval(opts.target.compilerExtension);
            }
            if (pxtc.compilerHooks.init)
                pxtc.compilerHooks.init(opts, service);
            let startTime = pxtc.U.cpuUs();
            let res = mkCompileResult();
            let program;
            if (service) {
                storeGeneratedFiles(opts, res);
                program = service.getProgram();
            }
            else {
                runConversionsAndStoreResults(opts, res);
                if (res.diagnostics.length > 0)
                    return res;
                program = buildProgram(opts, res);
            }
            const entryPoint = opts.sourceFiles.filter(f => pxtc.U.endsWith(f, ".ts")).pop().replace(/.*\//, "");
            // First get and report any syntactic errors.
            res.diagnostics = patchUpDiagnostics(program.getSyntacticDiagnostics(), opts.ignoreFileResolutionErrors);
            if (res.diagnostics.length > 0) {
                if (opts.forceEmit) {
                    pxt.debug('syntactic errors, forcing emit');
                    pxtc.compileBinary(program, opts, res, entryPoint);
                }
                return res;
            }
            // If we didn't have any syntactic errors, then also try getting the global and
            // semantic errors.
            res.diagnostics = patchUpDiagnostics(program.getOptionsDiagnostics().concat(pxtc.Util.toArray(program.getGlobalDiagnostics())), opts.ignoreFileResolutionErrors);
            const semStart = pxtc.U.cpuUs();
            if (res.diagnostics.length == 0) {
                res.diagnostics = patchUpDiagnostics(program.getSemanticDiagnostics(), opts.ignoreFileResolutionErrors);
            }
            const emitStart = pxtc.U.cpuUs();
            res.times["typescript-syn"] = semStart - startTime;
            res.times["typescript-sem"] = emitStart - semStart;
            res.times["typescript"] = emitStart - startTime;
            if (opts.ast) {
                res.ast = program;
            }
            if (opts.ast || opts.forceEmit || res.diagnostics.length == 0) {
                const binOutput = pxtc.compileBinary(program, opts, res, entryPoint);
                res.times["compilebinary"] = pxtc.U.cpuUs() - emitStart;
                res.diagnostics = res.diagnostics.concat(patchUpDiagnostics(binOutput.diagnostics));
            }
            if (res.diagnostics.length == 0)
                res.success = true;
            for (let f of opts.sourceFiles) {
                if (pxtc.Util.startsWith(f, "built/"))
                    res.outfiles[f.slice(6)] = opts.fileSystem[f];
            }
            res.times["all"] = pxtc.U.cpuUs() - startTime;
            pxt.tickEvent(`compile`, res.times);
            return res;
        }
        pxtc.compile = compile;
        function decompile(program, opts, fileName, includeGreyBlockMessages = false) {
            let file = program.getSourceFile(fileName);
            pxtc.annotate(program, fileName, pxtc.target || (pxt.appTarget && pxt.appTarget.compile));
            const apis = pxtc.getApiInfo(program, opts.jres);
            const blocksInfo = pxtc.getBlocksInfo(apis, opts.bannedCategories);
            const decompileOpts = {
                snippetMode: opts.snippetMode || false,
                alwaysEmitOnStart: opts.alwaysDecompileOnStart,
                includeGreyBlockMessages,
                generateSourceMap: !!opts.ast,
                allowedArgumentTypes: opts.allowedArgumentTypes || ["number", "boolean", "string"],
                errorOnGreyBlocks: !!opts.errorOnGreyBlocks
            };
            const [renameMap, _] = pxtc.decompiler.buildRenameMap(program, file, { declarations: "variables", takenNames: {} });
            const bresp = pxtc.decompiler.decompileToBlocks(blocksInfo, file, decompileOpts, renameMap);
            return bresp;
        }
        pxtc.decompile = decompile;
        // Decompile an array of code snippets (sourceTexts) to XML strings (blocks)
        function decompileSnippets(program, opts, includeGreyBlockMessages = false) {
            const apis = pxtc.getApiInfo(program, opts.jres);
            const blocksInfo = pxtc.getBlocksInfo(apis, opts.bannedCategories);
            const renameMap = new pxtc.decompiler.RenameMap([]); // Don't rename for snippets
            const decompileOpts = {
                snippetMode: opts.snippetMode || false,
                alwaysEmitOnStart: opts.alwaysDecompileOnStart,
                includeGreyBlockMessages,
                generateSourceMap: !!opts.ast,
                allowedArgumentTypes: opts.allowedArgumentTypes || ["number", "boolean", "string"],
                errorOnGreyBlocks: !!opts.errorOnGreyBlocks
            };
            let programCache; // Initialize to undefined, using the input program will incorrectly mark it as stale
            const xml = [];
            if (opts.sourceTexts) {
                for (let i = 0; i < opts.sourceTexts.length; i++) {
                    opts.fileSystem[pxt.MAIN_TS] = opts.sourceTexts[i];
                    opts.fileSystem[pxt.MAIN_BLOCKS] = "";
                    let newProgram = getTSProgram(opts, programCache);
                    const file = newProgram.getSourceFile(pxt.MAIN_TS);
                    const bresp = pxtc.decompiler.decompileToBlocks(blocksInfo, file, decompileOpts, renameMap);
                    xml.push(bresp.outfiles[pxt.MAIN_BLOCKS]);
                    programCache = newProgram;
                }
            }
            return xml;
        }
        pxtc.decompileSnippets = decompileSnippets;
        function getTSProgram(opts, old) {
            let outfiles = {};
            let fileText = {};
            for (let fileName in opts.fileSystem) {
                fileText[normalizePath(fileName)] = opts.fileSystem[fileName];
            }
            let setParentNodes = true;
            let options = getTsCompilerOptions(opts);
            let host = {
                getSourceFile: (fn, v, err) => {
                    fn = normalizePath(fn);
                    let text = "";
                    if (fileText.hasOwnProperty(fn)) {
                        text = fileText[fn];
                    }
                    else {
                        if (err)
                            err("File not found: " + fn);
                    }
                    if (text == null) {
                        err("File not found: " + fn);
                        text = "";
                    }
                    return ts.createSourceFile(fn, text, v, setParentNodes);
                },
                fileExists: fn => {
                    fn = normalizePath(fn);
                    return fileText.hasOwnProperty(fn);
                },
                getCanonicalFileName: fn => fn,
                getDefaultLibFileName: () => "no-default-lib.d.ts",
                writeFile: (fileName, data, writeByteOrderMark, onError) => {
                    outfiles[fileName] = data;
                },
                getCurrentDirectory: () => ".",
                useCaseSensitiveFileNames: () => true,
                getNewLine: () => "\n",
                readFile: fn => {
                    fn = normalizePath(fn);
                    return fileText[fn] || "";
                },
                directoryExists: dn => true,
                getDirectories: () => []
            };
            if (!opts.sourceFiles)
                opts.sourceFiles = Object.keys(opts.fileSystem);
            let tsFiles = opts.sourceFiles.filter(f => pxtc.U.endsWith(f, ".ts"));
            // ensure that main.ts is last of TS files
            let tsFilesNoMain = tsFiles.filter(f => f != pxt.MAIN_TS);
            let hasMain = false;
            if (tsFiles.length > tsFilesNoMain.length) {
                tsFiles = tsFilesNoMain;
                tsFiles.push(pxt.MAIN_TS);
                hasMain = true;
            }
            // run post-processing code last, if present
            const post_idx = tsFiles.indexOf(pxt.TUTORIAL_CODE_STOP);
            if (post_idx >= 0) {
                tsFiles.splice(post_idx, 1);
                tsFiles.push(pxt.TUTORIAL_CODE_STOP);
            }
            // TODO: ensure that main.ts is last???
            const program = ts.createProgram(tsFiles, options, host, old);
            pxtc.annotate(program, pxt.MAIN_TS, pxtc.target || (pxt.appTarget && pxt.appTarget.compile));
            return program;
        }
        pxtc.getTSProgram = getTSProgram;
        function normalizePath(path) {
            path = path.replace(/\\/g, "/");
            const parts = [];
            path.split("/").forEach(part => {
                if (part === ".." && parts.length) {
                    parts.pop();
                }
                else if (part !== ".") {
                    parts.push(part);
                }
            });
            return parts.join("/");
        }
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
var pxt;
(function (pxt) {
    var elf;
    (function (elf) {
        ;
        const progHeaderFields = [
            "type",
            "offset",
            "vaddr",
            "paddr",
            "filesz",
            "memsz",
            "flags",
            "align",
        ];
        ;
        const r32 = pxt.HF2.read32;
        const r16 = pxt.HF2.read16;
        const pageSize = 4096;
        function parse(buf) {
            if (r32(buf, 0) != 0x464c457f)
                pxt.U.userError("no magic");
            if (buf[4] != 1)
                pxt.U.userError("not 32 bit");
            if (buf[5] != 1)
                pxt.U.userError("not little endian");
            if (buf[6] != 1)
                pxt.U.userError("bad version");
            if (r16(buf, 0x10) != 2)
                pxt.U.userError("wrong object type");
            if (r16(buf, 0x12) != 0x28)
                pxt.U.userError("not ARM");
            let phoff = r32(buf, 0x1c);
            let shoff = r32(buf, 0x20);
            if (phoff == 0)
                pxt.U.userError("expecting program headers");
            let phentsize = r16(buf, 42);
            let phnum = r16(buf, 44);
            let progHeaders = pxt.U.range(phnum).map(no => readPH(phoff + no * phentsize));
            let addFileOff = buf.length + 1;
            while (addFileOff & 0xf)
                addFileOff++;
            let mapEnd = 0;
            for (let s of progHeaders) {
                if (s.type == 1 /* LOAD */)
                    mapEnd = Math.max(mapEnd, s.vaddr + s.memsz);
            }
            let addMemOff = ((mapEnd + pageSize - 1) & ~(pageSize - 1)) + (addFileOff & (pageSize - 1));
            let phOffset = -1;
            for (let s of progHeaders) {
                if (s.type == 4 /* NOTE */) {
                    phOffset = s._filepos;
                }
            }
            return {
                imageMemStart: addMemOff,
                imageFileStart: addFileOff,
                phOffset,
                template: buf
            };
            function readPH(off) {
                let r = {};
                let o0 = off;
                for (let f of progHeaderFields) {
                    r[f] = r32(buf, off);
                    off += 4;
                }
                let rr = r;
                rr._filepos = o0;
                return rr;
            }
        }
        elf.parse = parse;
        function patch(info, program) {
            let resBuf = new Uint8Array(info.imageFileStart + program.length);
            resBuf.fill(0);
            pxt.U.memcpy(resBuf, 0, info.template);
            pxt.U.memcpy(resBuf, info.imageFileStart, program);
            let ph = {
                _filepos: info.phOffset,
                type: 1 /* LOAD */,
                offset: info.imageFileStart,
                vaddr: info.imageMemStart,
                paddr: info.imageMemStart,
                filesz: program.length,
                memsz: program.length,
                flags: 4 /* R */ | 1 /* X */,
                align: pageSize
            };
            savePH(resBuf, ph);
            return resBuf;
            function savePH(buf, ph) {
                let off = ph._filepos;
                for (let f of progHeaderFields) {
                    pxt.HF2.write32(buf, off, ph[f] || 0);
                    off += 4;
                }
            }
        }
        elf.patch = patch;
    })(elf = pxt.elf || (pxt.elf = {}));
})(pxt || (pxt = {}));
var pxt;
(function (pxt) {
    var esp;
    (function (esp) {
        const r32 = pxt.HF2.read32;
        const r16 = pxt.HF2.read16;
        const chips = [
            {
                name: "esp32", chipId: 0,
                memmap: [
                    { from: 0x00000000, to: 0x00010000, id: "PADDING" },
                    { from: 0x3F400000, to: 0x3F800000, id: "DROM" },
                    { from: 0x3F800000, to: 0x3FC00000, id: "EXTRAM_DATA" },
                    { from: 0x3FF80000, to: 0x3FF82000, id: "RTC_DRAM" },
                    { from: 0x3FF90000, to: 0x40000000, id: "BYTE_ACCESSIBLE" },
                    { from: 0x3FFAE000, to: 0x40000000, id: "DRAM" },
                    { from: 0x3FFE0000, to: 0x3FFFFFFC, id: "DIRAM_DRAM" },
                    { from: 0x40000000, to: 0x40070000, id: "IROM" },
                    { from: 0x40070000, to: 0x40078000, id: "CACHE_PRO" },
                    { from: 0x40078000, to: 0x40080000, id: "CACHE_APP" },
                    { from: 0x40080000, to: 0x400A0000, id: "IRAM" },
                    { from: 0x400A0000, to: 0x400BFFFC, id: "DIRAM_IRAM" },
                    { from: 0x400C0000, to: 0x400C2000, id: "RTC_IRAM" },
                    { from: 0x400D0000, to: 0x40400000, id: "IROM" },
                    { from: 0x50000000, to: 0x50002000, id: "RTC_DATA" },
                ]
            },
            {
                name: "esp32-s2", chipId: 2,
                memmap: [
                    { from: 0x00000000, to: 0x00010000, id: "PADDING" },
                    { from: 0x3F000000, to: 0x3FF80000, id: "DROM" },
                    { from: 0x3F500000, to: 0x3FF80000, id: "EXTRAM_DATA" },
                    { from: 0x3FF9E000, to: 0x3FFA0000, id: "RTC_DRAM" },
                    { from: 0x3FF9E000, to: 0x40000000, id: "BYTE_ACCESSIBLE" },
                    { from: 0x3FF9E000, to: 0x40072000, id: "MEM_INTERNAL" },
                    { from: 0x3FFB0000, to: 0x40000000, id: "DRAM" },
                    { from: 0x40000000, to: 0x4001A100, id: "IROM_MASK" },
                    { from: 0x40020000, to: 0x40070000, id: "IRAM" },
                    { from: 0x40070000, to: 0x40072000, id: "RTC_IRAM" },
                    { from: 0x40080000, to: 0x40800000, id: "IROM" },
                    { from: 0x50000000, to: 0x50002000, id: "RTC_DATA" },
                ]
            },
            {
                name: "esp32-s3", chipId: 4,
                memmap: [
                    { from: 0x00000000, to: 0x00010000, id: "PADDING" },
                    { from: 0x3C000000, to: 0x3D000000, id: "DROM" },
                    { from: 0x3D000000, to: 0x3E000000, id: "EXTRAM_DATA" },
                    { from: 0x600FE000, to: 0x60100000, id: "RTC_DRAM" },
                    { from: 0x3FC88000, to: 0x3FD00000, id: "BYTE_ACCESSIBLE" },
                    { from: 0x3FC88000, to: 0x403E2000, id: "MEM_INTERNAL" },
                    { from: 0x3FC88000, to: 0x3FD00000, id: "DRAM" },
                    { from: 0x40000000, to: 0x4001A100, id: "IROM_MASK" },
                    { from: 0x40370000, to: 0x403E0000, id: "IRAM" },
                    { from: 0x600FE000, to: 0x60100000, id: "RTC_IRAM" },
                    { from: 0x42000000, to: 0x42800000, id: "IROM" },
                    { from: 0x50000000, to: 0x50002000, id: "RTC_DATA" },
                ]
            },
            {
                name: "esp32-c3", chipId: 5,
                memmap: [
                    { from: 0x00000000, to: 0x00010000, id: "PADDING" },
                    { from: 0x3C000000, to: 0x3C800000, id: "DROM" },
                    { from: 0x3FC80000, to: 0x3FCE0000, id: "DRAM" },
                    { from: 0x3FC88000, to: 0x3FD00000, id: "BYTE_ACCESSIBLE" },
                    { from: 0x3FF00000, to: 0x3FF20000, id: "DROM_MASK" },
                    { from: 0x40000000, to: 0x40060000, id: "IROM_MASK" },
                    { from: 0x42000000, to: 0x42800000, id: "IROM" },
                    { from: 0x4037C000, to: 0x403E0000, id: "IRAM" },
                    { from: 0x50000000, to: 0x50002000, id: "RTC_IRAM" },
                    { from: 0x50000000, to: 0x50002000, id: "RTC_DRAM" },
                    { from: 0x600FE000, to: 0x60100000, id: "MEM_INTERNAL2" },
                ]
            },
        ];
        const segHdLen = 8;
        function segToString(seg) {
            return `0x${seg.addr.toString(16)} 0x${seg.data.length.toString(16)} bytes; ` +
                `${seg.isDROM ? "drom " : ""}${seg.isMapped ? "mapped " : ""}${pxt.U.toHex(seg.data.slice(0, 20))}...`;
        }
        function padSegments(image) {
            const align = 0x10000;
            const alignMask = align - 1;
            image = cloneStruct(image);
            image.segments.sort((a, b) => a.addr - b.addr);
            pxt.debug("esp padding:\n" + image.segments.map(segToString).join("\n") + "\n");
            const mapped = image.segments.filter(s => s.isMapped);
            const nonMapped = image.segments.filter(s => !s.isMapped);
            image.segments = [];
            let foff = image.header.length;
            for (const seg of mapped) {
                // there's apparently a bug in ESP32 bootloader, that doesn't map the last page if it's smaller than 0x24
                const leftoff = (seg.addr + seg.data.length) & alignMask;
                if (leftoff < 0x24) {
                    const padding = new Uint8Array(0x24 - leftoff);
                    seg.data = pxt.U.uint8ArrayConcat([seg.data, padding]);
                }
            }
            while (mapped.length > 0) {
                let seg = mapped[0];
                const padLen = alignmentNeeded(seg);
                if (padLen > 0) {
                    seg = getPaddingSegment(padLen);
                }
                else {
                    if (((foff + segHdLen) & alignMask) != (seg.addr & alignMask)) {
                        throw new Error(`pad oops 0 ${foff}+${segHdLen} != ${seg.addr} (mod mask)`);
                    }
                    mapped.shift();
                }
                image.segments.push(seg);
                foff += segHdLen + seg.data.length;
                if (foff & 3)
                    throw new Error("pad oops 1");
            }
            // append any remaining non-mapped segments
            image.segments = image.segments.concat(nonMapped);
            pxt.debug("esp padded:\n" + image.segments.map(segToString).join("\n") + "\n");
            return image;
            function alignmentNeeded(seg) {
                const reqd = (seg.addr - segHdLen) & alignMask;
                let padLen = (reqd - foff) & alignMask;
                if (padLen == 0)
                    return 0;
                padLen -= segHdLen;
                if (padLen < 0)
                    padLen += align;
                return padLen;
            }
            function getPaddingSegment(bytes) {
                if (!nonMapped.length || bytes <= segHdLen)
                    return {
                        addr: 0,
                        isMapped: false,
                        isDROM: false,
                        data: new Uint8Array(bytes)
                    };
                const seg = nonMapped[0];
                const res = {
                    addr: seg.addr,
                    isMapped: seg.isMapped,
                    isDROM: seg.isDROM,
                    data: seg.data.slice(0, bytes)
                };
                seg.data = seg.data.slice(bytes);
                seg.addr += res.data.length;
                if (seg.data.length == 0)
                    nonMapped.shift();
                return res;
            }
        }
        function toBuffer(image, digest = true) {
            image = padSegments(image);
            let size = image.header.length;
            for (const seg of image.segments) {
                size += segHdLen + seg.data.length;
            }
            size = (size + 16) & ~15; // align to 16 bytes - last byte will be weak checksum
            let res = new Uint8Array(size);
            res.set(image.header);
            res[1] = image.segments.length;
            let off = image.header.length;
            let checksum = 0xEF;
            for (const seg of image.segments) {
                pxt.HF2.write32(res, off, seg.addr);
                pxt.HF2.write32(res, off + 4, seg.data.length);
                res.set(seg.data, off + segHdLen);
                off += segHdLen + seg.data.length;
                for (let i = 0; i < seg.data.length; ++i)
                    checksum ^= seg.data[i];
            }
            res[res.length - 1] = checksum;
            if (digest) {
                res[23] = 1;
                const digest = ts.pxtc.BrowserImpl.sha256buffer(res);
                res = pxt.U.uint8ArrayConcat([res, pxt.U.fromHex(digest)]);
            }
            else {
                res[23] = 0; // disable digest
            }
            // console.log("reparsed\n" + parseBuffer(res).segments.map(segToString).join("\n") + "\n")
            return res;
        }
        esp.toBuffer = toBuffer;
        function parseBuffer(buf) {
            if (buf[0] != 0xE9)
                throw new Error("ESP: invalid magic: " + buf[0]);
            let ptr = 24;
            const chipId = r16(buf, 12);
            const chipdesc = chips.find(c => c.chipId == chipId);
            if (!chipdesc)
                throw new Error("ESP: unknown chipid: " + chipId);
            const image = {
                header: buf.slice(0, ptr),
                chipName: chipdesc.name,
                segments: []
            };
            const numseg = buf[1];
            for (let i = 0; i < numseg; ++i) {
                const offset = r32(buf, ptr);
                const size = r32(buf, ptr + 4);
                ptr += segHdLen;
                const data = buf.slice(ptr, ptr + size);
                if (data.length != size)
                    throw new Error("too short file");
                ptr += size;
                if (isInSection(offset, "PADDING"))
                    continue;
                const ex = image.segments.filter(seg => seg.addr + seg.data.length == offset)[0];
                if (ex)
                    ex.data = pxt.U.uint8ArrayConcat([ex.data, data]);
                else
                    image.segments.push({
                        addr: offset,
                        isMapped: isInSection(offset, "DROM") || isInSection(offset, "IROM"),
                        isDROM: isInSection(offset, "DROM"),
                        data: data
                    });
            }
            return image;
            function isInSection(addr, sect) {
                return chipdesc.memmap.some(m => m.id == sect && m.from <= addr && addr <= m.to);
            }
        }
        esp.parseBuffer = parseBuffer;
        function parseB64(lines) {
            return parseBuffer(pxt.U.stringToUint8Array(atob(lines.join(""))));
        }
        esp.parseB64 = parseB64;
        function cloneStruct(img) {
            const res = pxt.U.flatClone(img);
            res.segments = res.segments.map(pxt.U.flatClone);
            return res;
        }
        esp.cloneStruct = cloneStruct;
    })(esp = pxt.esp || (pxt.esp = {}));
})(pxt || (pxt = {}));
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        let TokenKind;
        (function (TokenKind) {
            TokenKind[TokenKind["None"] = 0] = "None";
            TokenKind[TokenKind["Whitespace"] = 1] = "Whitespace";
            TokenKind[TokenKind["Identifier"] = 2] = "Identifier";
            TokenKind[TokenKind["Keyword"] = 3] = "Keyword";
            TokenKind[TokenKind["Operator"] = 4] = "Operator";
            TokenKind[TokenKind["CommentLine"] = 5] = "CommentLine";
            TokenKind[TokenKind["CommentBlock"] = 6] = "CommentBlock";
            TokenKind[TokenKind["NewLine"] = 7] = "NewLine";
            TokenKind[TokenKind["Literal"] = 8] = "Literal";
            TokenKind[TokenKind["Tree"] = 9] = "Tree";
            TokenKind[TokenKind["Block"] = 10] = "Block";
            TokenKind[TokenKind["EOF"] = 11] = "EOF";
        })(TokenKind || (TokenKind = {}));
        let inputForMsg = "";
        function lookupKind(k) {
            for (let o of Object.keys(ts.SyntaxKind)) {
                if (ts.SyntaxKind[o] === k)
                    return o;
            }
            return "?";
        }
        let SK = ts.SyntaxKind;
        function showMsg(t, msg) {
            let pos = t.pos;
            let ctx = inputForMsg.slice(pos - 20, pos) + "<*>" + inputForMsg.slice(pos, pos + 20);
            console.log(ctx.replace(/\n/g, "<NL>"), ": L ", t.lineNo, msg);
        }
        function infixOperatorPrecedence(kind) {
            switch (kind) {
                case SK.CommaToken:
                    return 2;
                case SK.EqualsToken:
                case SK.PlusEqualsToken:
                case SK.MinusEqualsToken:
                case SK.AsteriskEqualsToken:
                case SK.AsteriskAsteriskEqualsToken:
                case SK.SlashEqualsToken:
                case SK.PercentEqualsToken:
                case SK.LessThanLessThanEqualsToken:
                case SK.GreaterThanGreaterThanEqualsToken:
                case SK.GreaterThanGreaterThanGreaterThanEqualsToken:
                case SK.AmpersandEqualsToken:
                case SK.BarEqualsToken:
                case SK.CaretEqualsToken:
                    return 5;
                case SK.QuestionToken:
                case SK.ColonToken:
                    return 7; // ternary operator
                case SK.BarBarToken:
                    return 10;
                case SK.AmpersandAmpersandToken:
                    return 20;
                case SK.BarToken:
                    return 30;
                case SK.CaretToken:
                    return 40;
                case SK.AmpersandToken:
                    return 50;
                case SK.EqualsEqualsToken:
                case SK.ExclamationEqualsToken:
                case SK.EqualsEqualsEqualsToken:
                case SK.ExclamationEqualsEqualsToken:
                    return 60;
                case SK.LessThanToken:
                case SK.GreaterThanToken:
                case SK.LessThanEqualsToken:
                case SK.GreaterThanEqualsToken:
                case SK.InstanceOfKeyword:
                case SK.InKeyword:
                case SK.AsKeyword:
                    return 70;
                case SK.LessThanLessThanToken:
                case SK.GreaterThanGreaterThanToken:
                case SK.GreaterThanGreaterThanGreaterThanToken:
                    return 80;
                case SK.PlusToken:
                case SK.MinusToken:
                    return 90;
                case SK.AsteriskToken:
                case SK.SlashToken:
                case SK.PercentToken:
                    return 100;
                case SK.AsteriskAsteriskToken:
                    return 101;
                case SK.DotToken:
                    return 120;
                default:
                    return 0;
            }
        }
        function getTokKind(kind) {
            switch (kind) {
                case SK.EndOfFileToken:
                    return TokenKind.EOF;
                case SK.SingleLineCommentTrivia:
                    return TokenKind.CommentLine;
                case SK.MultiLineCommentTrivia:
                    return TokenKind.CommentBlock;
                case SK.NewLineTrivia:
                    return TokenKind.NewLine;
                case SK.WhitespaceTrivia:
                    return TokenKind.Whitespace;
                case SK.ShebangTrivia:
                case SK.ConflictMarkerTrivia:
                    return TokenKind.CommentBlock;
                case SK.NumericLiteral:
                case SK.StringLiteral:
                case SK.RegularExpressionLiteral:
                case SK.NoSubstitutionTemplateLiteral:
                case SK.TemplateHead:
                case SK.TemplateMiddle:
                case SK.TemplateTail:
                    return TokenKind.Literal;
                case SK.Identifier:
                    return TokenKind.Identifier;
                default:
                    if (kind < SK.Identifier)
                        return TokenKind.Operator;
                    return TokenKind.Keyword;
            }
        }
        let brokenRegExps = false;
        function tokenize(input) {
            inputForMsg = input;
            let scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, input, msg => {
                let pos = scanner.getTextPos();
                console.log("scanner error", pos, msg.message);
            });
            let tokens = [];
            let braceBalance = 0;
            let templateLevel = -1;
            while (true) {
                let kind = scanner.scan();
                if (kind == SK.CloseBraceToken && braceBalance == templateLevel) {
                    templateLevel = -1;
                    kind = scanner.reScanTemplateToken();
                }
                if (brokenRegExps && kind == SK.SlashToken || kind == SK.SlashEqualsToken) {
                    let tmp = scanner.reScanSlashToken();
                    if (tmp == SK.RegularExpressionLiteral)
                        kind = tmp;
                }
                if (kind == SK.GreaterThanToken) {
                    kind = scanner.reScanGreaterToken();
                }
                let tok = {
                    kind: getTokKind(kind),
                    synKind: kind,
                    lineNo: 0,
                    pos: scanner.getTokenPos(),
                    text: scanner.getTokenText(),
                };
                if (kind == SK.OpenBraceToken)
                    braceBalance++;
                if (kind == SK.CloseBraceToken) {
                    if (--braceBalance < 0)
                        braceBalance = -10000000;
                }
                tokens.push(tok);
                if (kind == SK.TemplateHead || kind == SK.TemplateMiddle) {
                    templateLevel = braceBalance;
                }
                if (tok.kind == TokenKind.EOF)
                    break;
            }
            // Util.assert(tokens.map(t => t.text).join("") == input)
            return { tokens, braceBalance };
        }
        function skipWhitespace(tokens, i) {
            while (tokens[i] && tokens[i].kind == TokenKind.Whitespace)
                i++;
            return i;
        }
        // We do not want empty lines in the source to get lost - they serve as a sort of comment dividing parts of code
        // We turn them into empty comments here
        function emptyLinesToComments(tokens, cursorPos) {
            let output = [];
            let atLineBeg = true;
            let lineNo = 1;
            for (let i = 0; i < tokens.length; ++i) {
                if (atLineBeg) {
                    let bkp = i;
                    i = skipWhitespace(tokens, i);
                    if (tokens[i].kind == TokenKind.NewLine) {
                        let isCursor = false;
                        if (cursorPos >= 0 && tokens[i].pos >= cursorPos) {
                            cursorPos = -1;
                            isCursor = true;
                        }
                        output.push({
                            text: "",
                            kind: TokenKind.CommentLine,
                            pos: tokens[i].pos,
                            lineNo,
                            synKind: SK.SingleLineCommentTrivia,
                            isCursor: isCursor
                        });
                    }
                    else {
                        i = bkp;
                    }
                }
                output.push(tokens[i]);
                tokens[i].lineNo = lineNo;
                if (tokens[i].kind == TokenKind.NewLine) {
                    atLineBeg = true;
                    lineNo++;
                }
                else {
                    atLineBeg = false;
                }
                if (cursorPos >= 0 && tokens[i].pos >= cursorPos) {
                    cursorPos = -1;
                }
            }
            return output;
        }
        // Add Tree tokens where needed
        function matchBraces(tokens) {
            let braceStack = [];
            let braceTop = () => braceStack[braceStack.length - 1];
            braceStack.push({
                synKind: SK.EndOfFileToken,
                token: {
                    children: [],
                },
            });
            let pushClose = (tok, synKind) => {
                let token = tok;
                token.children = [];
                token.kind = TokenKind.Tree;
                braceStack.push({ synKind, token });
            };
            for (let i = 0; i < tokens.length; ++i) {
                let token = tokens[i];
                let top = braceStack[braceStack.length - 1];
                top.token.children.push(token);
                switch (token.kind) {
                    case TokenKind.Operator:
                        switch (token.synKind) {
                            case SK.OpenBraceToken:
                            case SK.OpenParenToken:
                            case SK.OpenBracketToken:
                                pushClose(token, token.synKind + 1);
                                break;
                            case SK.CloseBraceToken:
                            case SK.CloseParenToken:
                            case SK.CloseBracketToken:
                                top.token.children.pop();
                                while (true) {
                                    top = braceStack.pop();
                                    if (top.synKind == token.synKind) {
                                        top.token.endToken = token;
                                        break;
                                    }
                                    // don't go past brace with other closing parens
                                    if (braceStack.length == 0 || top.synKind == SK.CloseBraceToken) {
                                        braceStack.push(top);
                                        break;
                                    }
                                }
                                break;
                            default:
                                break;
                        }
                        break;
                }
            }
            return braceStack[0].token.children;
        }
        function mkEOF() {
            return {
                kind: TokenKind.EOF,
                synKind: SK.EndOfFileToken,
                pos: 0,
                lineNo: 0,
                text: ""
            };
        }
        function mkSpace(t, s) {
            return {
                kind: TokenKind.Whitespace,
                synKind: SK.WhitespaceTrivia,
                pos: t.pos - s.length,
                lineNo: t.lineNo,
                text: s
            };
        }
        function mkNewLine(t) {
            return {
                kind: TokenKind.NewLine,
                synKind: SK.NewLineTrivia,
                pos: t.pos,
                lineNo: t.lineNo,
                text: "\n"
            };
        }
        function mkBlock(toks) {
            return {
                kind: TokenKind.Block,
                synKind: SK.OpenBraceToken,
                pos: toks[0].pos,
                lineNo: toks[0].lineNo,
                stmts: [{ tokens: toks }],
                text: "{",
                endToken: null
            };
        }
        function mkVirtualTree(toks) {
            return {
                kind: TokenKind.Tree,
                synKind: SK.WhitespaceTrivia,
                pos: toks[0].pos,
                lineNo: toks[0].lineNo,
                children: toks,
                endToken: null,
                text: ""
            };
        }
        function isExprEnd(t) {
            if (!t)
                return false;
            switch (t.synKind) {
                case SK.IfKeyword:
                case SK.ElseKeyword:
                case SK.LetKeyword:
                case SK.ConstKeyword:
                case SK.VarKeyword:
                case SK.DoKeyword:
                case SK.WhileKeyword:
                case SK.SwitchKeyword:
                case SK.CaseKeyword:
                case SK.DefaultKeyword:
                case SK.ForKeyword:
                case SK.ReturnKeyword:
                case SK.BreakKeyword:
                case SK.ContinueKeyword:
                case SK.TryKeyword:
                case SK.CatchKeyword:
                case SK.FinallyKeyword:
                case SK.DeleteKeyword:
                case SK.FunctionKeyword:
                case SK.ClassKeyword:
                case SK.YieldKeyword:
                case SK.DebuggerKeyword:
                    return true;
                default:
                    return false;
            }
        }
        function delimitStmts(tokens, inStmtCtx, ctxToken = null) {
            let res = [];
            let i = 0;
            let currCtxToken;
            let didBlock = false;
            tokens = tokens.concat([mkEOF()]);
            while (tokens[i].kind != TokenKind.EOF) {
                let stmtBeg = i;
                skipToStmtEnd();
                pxtc.Util.assert(i > stmtBeg, `Error at ${tokens[i].text}`);
                addStatement(tokens.slice(stmtBeg, i));
            }
            return res;
            function addStatement(tokens) {
                if (inStmtCtx)
                    tokens = trimWhitespace(tokens);
                if (tokens.length == 0)
                    return;
                tokens.forEach(delimitIn);
                tokens = injectBlocks(tokens);
                let merge = false;
                if (inStmtCtx && res.length > 0) {
                    let prev = res[res.length - 1];
                    let prevKind = prev.tokens[0].synKind;
                    let thisKind = tokens[0].synKind;
                    if ((prevKind == SK.IfKeyword && thisKind == SK.ElseKeyword) ||
                        (prevKind == SK.TryKeyword && thisKind == SK.CatchKeyword) ||
                        (prevKind == SK.TryKeyword && thisKind == SK.FinallyKeyword) ||
                        (prevKind == SK.CatchKeyword && thisKind == SK.FinallyKeyword)) {
                        tokens.unshift(mkSpace(tokens[0], " "));
                        pxtc.Util.pushRange(res[res.length - 1].tokens, tokens);
                        return;
                    }
                }
                res.push({
                    tokens: tokens
                });
            }
            function injectBlocks(tokens) {
                let output = [];
                let i = 0;
                while (i < tokens.length) {
                    if (tokens[i].blockSpanLength) {
                        let inner = tokens.slice(i, i + tokens[i].blockSpanLength);
                        let isVirtual = !!inner[0].blockSpanIsVirtual;
                        delete inner[0].blockSpanLength;
                        delete inner[0].blockSpanIsVirtual;
                        i += inner.length;
                        inner = injectBlocks(inner);
                        if (isVirtual) {
                            output.push(mkVirtualTree(inner));
                        }
                        else {
                            output.push(mkSpace(inner[0], " "));
                            output.push(mkBlock(trimWhitespace(inner)));
                        }
                    }
                    else {
                        output.push(tokens[i++]);
                    }
                }
                return output;
            }
            function delimitIn(t) {
                if (t.kind == TokenKind.Tree) {
                    let tree = t;
                    tree.children = pxtc.Util.concat(delimitStmts(tree.children, false, tree).map(s => s.tokens));
                }
            }
            function nextNonWs(stopOnNewLine = false) {
                while (true) {
                    i++;
                    switch (tokens[i].kind) {
                        case TokenKind.Whitespace:
                        case TokenKind.CommentBlock:
                        case TokenKind.CommentLine:
                            break;
                        case TokenKind.NewLine:
                            if (stopOnNewLine)
                                break;
                            break;
                        default:
                            return;
                    }
                }
            }
            function skipOptionalNewLine() {
                while (tokens[i].kind == TokenKind.Whitespace) {
                    i++;
                }
                if (tokens[i].kind == TokenKind.NewLine)
                    i++;
            }
            function skipUntilBlock() {
                while (true) {
                    i++;
                    switch (tokens[i].kind) {
                        case TokenKind.EOF:
                            return;
                        case TokenKind.Tree:
                            if (tokens[i].synKind == SK.OpenBraceToken) {
                                i--;
                                expectBlock();
                                return;
                            }
                            break;
                    }
                }
            }
            function handleBlock() {
                pxtc.Util.assert(tokens[i].synKind == SK.OpenBraceToken);
                let tree = tokens[i];
                pxtc.Util.assert(tree.kind == TokenKind.Tree);
                let blk = tokens[i];
                blk.stmts = delimitStmts(tree.children, true, currCtxToken);
                delete tree.children;
                blk.kind = TokenKind.Block;
                i++;
                didBlock = true;
            }
            function expectBlock() {
                let begIdx = i + 1;
                nextNonWs();
                if (tokens[i].synKind == SK.OpenBraceToken) {
                    handleBlock();
                    skipOptionalNewLine();
                }
                else {
                    skipToStmtEnd();
                    tokens[begIdx].blockSpanLength = i - begIdx;
                }
            }
            function skipToStmtEnd() {
                while (true) {
                    let t = tokens[i];
                    let bkp = i;
                    currCtxToken = t;
                    didBlock = false;
                    if (t.kind == TokenKind.EOF)
                        return;
                    if (inStmtCtx && t.synKind == SK.SemicolonToken) {
                        i++;
                        skipOptionalNewLine();
                        return;
                    }
                    if (t.synKind == SK.EqualsGreaterThanToken) {
                        nextNonWs();
                        if (tokens[i].synKind == SK.OpenBraceToken) {
                            handleBlock();
                            continue;
                        }
                        else {
                            let begIdx = i;
                            skipToStmtEnd();
                            let j = i;
                            while (tokens[j].kind == TokenKind.NewLine)
                                j--;
                            tokens[begIdx].blockSpanLength = j - begIdx;
                            tokens[begIdx].blockSpanIsVirtual = true;
                            return;
                        }
                    }
                    if (inStmtCtx && infixOperatorPrecedence(t.synKind)) {
                        let begIdx = i;
                        // an infix operator at the end of the line prevents the newline from ending the statement
                        nextNonWs();
                        if (isExprEnd(tokens[i])) {
                            // unless next line starts with something statement-like
                            i = begIdx;
                        }
                        else {
                            continue;
                        }
                    }
                    if (inStmtCtx && t.kind == TokenKind.NewLine) {
                        nextNonWs();
                        t = tokens[i];
                        // if we get a infix operator other than +/- after newline, it's a continuation
                        if (infixOperatorPrecedence(t.synKind) && t.synKind != SK.PlusToken && t.synKind != SK.MinusToken) {
                            continue;
                        }
                        else {
                            i = bkp + 1;
                            return;
                        }
                    }
                    if (t.synKind == SK.OpenBraceToken && ctxToken && ctxToken.synKind == SK.ClassKeyword) {
                        let jj = i - 1;
                        while (jj >= 0 && tokens[jj].kind == TokenKind.Whitespace)
                            jj--;
                        if (jj < 0 || tokens[jj].synKind != SK.EqualsToken) {
                            i--;
                            expectBlock(); // method body
                            return;
                        }
                    }
                    pxtc.Util.assert(bkp == i);
                    switch (t.synKind) {
                        case SK.ForKeyword:
                        case SK.WhileKeyword:
                        case SK.IfKeyword:
                        case SK.CatchKeyword:
                            nextNonWs();
                            if (tokens[i].synKind == SK.OpenParenToken) {
                                expectBlock();
                            }
                            else {
                                continue; // just continue until new line
                            }
                            return;
                        case SK.DoKeyword:
                            expectBlock();
                            i--;
                            nextNonWs();
                            if (tokens[i].synKind == SK.WhileKeyword) {
                                i++;
                                continue;
                            }
                            else {
                                return;
                            }
                        case SK.ElseKeyword:
                            nextNonWs();
                            if (tokens[i].synKind == SK.IfKeyword) {
                                continue; // 'else if' - keep scanning
                            }
                            else {
                                i = bkp;
                                expectBlock();
                                return;
                            }
                        case SK.TryKeyword:
                        case SK.FinallyKeyword:
                            expectBlock();
                            return;
                        case SK.ClassKeyword:
                        case SK.NamespaceKeyword:
                        case SK.ModuleKeyword:
                        case SK.InterfaceKeyword:
                        case SK.FunctionKeyword:
                            skipUntilBlock();
                            return;
                    }
                    pxtc.Util.assert(!didBlock, "forgot continue/return after expectBlock");
                    i++;
                }
            }
        }
        function isWhitespaceOrNewLine(tok) {
            return tok && (tok.kind == TokenKind.Whitespace || tok.kind == TokenKind.NewLine);
        }
        function removeIndent(tokens) {
            let output = [];
            let atLineBeg = false;
            for (let i = 0; i < tokens.length; ++i) {
                if (atLineBeg)
                    i = skipWhitespace(tokens, i);
                if (tokens[i]) {
                    output.push(tokens[i]);
                    atLineBeg = tokens[i].kind == TokenKind.NewLine;
                }
            }
            return output;
        }
        function trimWhitespace(toks) {
            toks = toks.slice(0);
            while (isWhitespaceOrNewLine(toks[0]))
                toks.shift();
            while (isWhitespaceOrNewLine(toks[toks.length - 1]))
                toks.pop();
            return toks;
        }
        function normalizeSpace(tokens) {
            let output = [];
            let i = 0;
            let lastNonTrivialToken = mkEOF();
            tokens = tokens.concat([mkEOF()]);
            while (i < tokens.length) {
                i = skipWhitespace(tokens, i);
                let token = tokens[i];
                if (token.kind == TokenKind.EOF)
                    break;
                let j = skipWhitespace(tokens, i + 1);
                if (token.kind == TokenKind.NewLine && tokens[j].synKind == SK.OpenBraceToken) {
                    i = j; // skip NL
                    continue;
                }
                let needsSpace = true;
                let last = output.length == 0 ? mkNewLine(token) : output[output.length - 1];
                switch (last.synKind) {
                    case SK.ExclamationToken:
                    case SK.TildeToken:
                    case SK.DotToken:
                        needsSpace = false;
                        break;
                    case SK.PlusToken:
                    case SK.MinusToken:
                    case SK.PlusPlusToken:
                    case SK.MinusMinusToken:
                        if (last.isPrefix)
                            needsSpace = false;
                        break;
                }
                switch (token.synKind) {
                    case SK.DotToken:
                    case SK.CommaToken:
                    case SK.NewLineTrivia:
                    case SK.ColonToken:
                    case SK.SemicolonToken:
                    case SK.OpenBracketToken:
                        needsSpace = false;
                        break;
                    case SK.PlusPlusToken:
                    case SK.MinusMinusToken:
                        if (last.kind == TokenKind.Tree || last.kind == TokenKind.Identifier || last.kind == TokenKind.Keyword)
                            needsSpace = false;
                    /* fall through */
                    case SK.PlusToken:
                    case SK.MinusToken:
                        if (lastNonTrivialToken.kind == TokenKind.EOF ||
                            infixOperatorPrecedence(lastNonTrivialToken.synKind) ||
                            lastNonTrivialToken.synKind == SK.SemicolonToken)
                            token.isPrefix = true;
                        break;
                    case SK.OpenParenToken:
                        if (last.kind == TokenKind.Identifier)
                            needsSpace = false;
                        if (last.kind == TokenKind.Keyword)
                            switch (last.synKind) {
                                case SK.IfKeyword:
                                case SK.ForKeyword:
                                case SK.WhileKeyword:
                                case SK.SwitchKeyword:
                                case SK.ReturnKeyword:
                                case SK.ThrowKeyword:
                                case SK.CatchKeyword:
                                    break;
                                default:
                                    needsSpace = false;
                            }
                        break;
                }
                if (last.kind == TokenKind.NewLine)
                    needsSpace = false;
                if (needsSpace)
                    output.push(mkSpace(token, " "));
                output.push(token);
                if (token.kind != TokenKind.NewLine)
                    lastNonTrivialToken = token;
                i++;
            }
            return output;
        }
        function finalFormat(ind, token) {
            if (token.synKind == SK.NoSubstitutionTemplateLiteral &&
                /^`[\s\.#01]*`$/.test(token.text)) {
                let lines = token.text.slice(1, token.text.length - 1).split("\n").map(l => l.replace(/\s/g, "")).filter(l => !!l);
                if (lines.length < 4 || lines.length > 5)
                    return;
                let numFrames = Math.floor((Math.max(...lines.map(l => l.length)) + 2) / 5);
                if (numFrames <= 0)
                    numFrames = 1;
                let out = "`\n";
                for (let i = 0; i < 5; ++i) {
                    let l = lines[i] || "";
                    while (l.length < numFrames * 5)
                        l += ".";
                    l = l.replace(/0/g, ".");
                    l = l.replace(/1/g, "#");
                    l = l.replace(/...../g, m => "/" + m);
                    out += ind + l.replace(/./g, m => " " + m).replace(/\//g, " ").slice(3) + "\n";
                }
                out += ind + "`";
                token.text = out;
            }
        }
        function toStr(v) {
            if (Array.isArray(v))
                return "[[ " + v.map(toStr).join("  ") + " ]]";
            if (typeof v.text == "string")
                return JSON.stringify(v.text);
            return v + "";
        }
        pxtc.toStr = toStr;
        function format(input, pos) {
            let r = tokenize(input);
            //if (r.braceBalance != 0) return null
            let topTokens = r.tokens;
            topTokens = emptyLinesToComments(topTokens, pos);
            topTokens = matchBraces(topTokens);
            let topStmts = delimitStmts(topTokens, true);
            let ind = "";
            let output = "";
            let outpos = -1;
            let indIncrLine = 0;
            topStmts.forEach(ppStmt);
            topStmts.forEach(s => s.tokens.forEach(findNonBlocks));
            if (outpos == -1)
                outpos = output.length;
            return {
                formatted: output,
                pos: outpos
            };
            function findNonBlocks(t) {
                if (t.kind == TokenKind.Tree) {
                    let tree = t;
                    if (t.synKind == SK.OpenBraceToken) {
                        //showMsg(t, "left behind X")
                    }
                    tree.children.forEach(findNonBlocks);
                }
                else if (t.kind == TokenKind.Block) {
                    t.stmts.forEach(s => s.tokens.forEach(findNonBlocks));
                }
            }
            function incrIndent(parToken, f) {
                if (indIncrLine == parToken.lineNo) {
                    f();
                }
                else {
                    indIncrLine = parToken.lineNo;
                    let prev = ind;
                    ind += "    ";
                    f();
                    ind = prev;
                }
            }
            function ppStmt(s) {
                let toks = removeIndent(s.tokens);
                if (toks.length == 1 && !toks[0].isCursor && toks[0].text == "") {
                    output += "\n";
                    return;
                }
                output += ind;
                incrIndent(toks[0], () => {
                    ppToks(toks);
                });
                if (output[output.length - 1] != "\n")
                    output += "\n";
            }
            function writeToken(t) {
                if (outpos == -1 && t.pos + t.text.length >= pos) {
                    outpos = output.length + (pos - t.pos);
                }
                output += t.text;
            }
            function ppToks(tokens) {
                tokens = normalizeSpace(tokens);
                for (let i = 0; i < tokens.length; ++i) {
                    let t = tokens[i];
                    finalFormat(ind, t);
                    writeToken(t);
                    switch (t.kind) {
                        case TokenKind.Tree:
                            let tree = t;
                            incrIndent(t, () => {
                                ppToks(removeIndent(tree.children));
                            });
                            if (tree.endToken) {
                                writeToken(tree.endToken);
                            }
                            break;
                        case TokenKind.Block:
                            let blk = t;
                            if (blk.stmts.length == 0) {
                                output += " ";
                            }
                            else {
                                output += "\n";
                                blk.stmts.forEach(ppStmt);
                                output += ind.slice(4);
                            }
                            if (blk.endToken)
                                writeToken(blk.endToken);
                            else
                                output += "}";
                            break;
                        case TokenKind.NewLine:
                            if (tokens[i + 1] && tokens[i + 1].kind == TokenKind.CommentLine &&
                                tokens[i + 1].text == "" && !tokens[i + 1].isCursor)
                                break; // no indent for empty line
                            if (i == tokens.length - 1)
                                output += ind.slice(4);
                            else
                                output += ind;
                            break;
                        case TokenKind.Whitespace:
                            break;
                    }
                }
            }
        }
        pxtc.format = format;
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        // HEX file documentation at: https://en.wikipedia.org/wiki/Intel_HEX
        /* From above:
        This example shows a file that has four data records followed by an end-of-file record:
    
    :10010000214601360121470136007EFE09D2190140
    :100110002146017E17C20001FF5F16002148011928
    :10012000194E79234623965778239EDA3F01B2CAA7
    :100130003F0156702B5E712B722B732146013421C7
    :00000001FF
    
            A record (line of text) consists of six fields (parts) that appear in order from left to right:
            - Start code, one character, an ASCII colon ':'.
            - Byte count, two hex digits, indicating the number of bytes (hex digit pairs) in the data field.
              The maximum byte count is 255 (0xFF). 16 (0x10) and 32 (0x20) are commonly used byte counts.
            - Address, four hex digits, representing the 16-bit beginning memory address offset of the data.
              The physical address of the data is computed by adding this offset to a previously established
              base address, thus allowing memory addressing beyond the 64 kilobyte limit of 16-bit addresses.
              The base address, which defaults to zero, can be changed by various types of records.
              Base addresses and address offsets are always expressed as big endian values.
            - Record type (see record types below), two hex digits, 00 to 05, defining the meaning of the data field.
            - Data, a sequence of n bytes of data, represented by 2n hex digits. Some records omit this field (n equals zero).
              The meaning and interpretation of data bytes depends on the application.
            - Checksum, two hex digits, a computed value that can be used to verify the record has no errors.
    
        */
        let hexfile;
        (function (hexfile) {
            const defaultPageSize = 0x400;
            // this is for inline assembly
            hexfile.asmTotalSource = "";
            let asmLabels = {};
            let cachedCtxs = [];
            function emptyCtx() {
                return {
                    commBase: 0,
                    funcInfo: {},
                    codeStartIdx: -1,
                    codePaddingSize: 0,
                    sha: null,
                    codeStartAddrPadded: undefined,
                    hexlines: undefined,
                    jmpStartAddr: undefined,
                    jmpStartIdx: undefined,
                    codeStartAddr: undefined,
                    elfInfo: undefined,
                    espInfo: undefined,
                };
            }
            let ctx = emptyCtx();
            function getCommBase() {
                return ctx.commBase;
            }
            hexfile.getCommBase = getCommBase;
            function getStartAddress() {
                return ctx.codeStartAddrPadded;
            }
            hexfile.getStartAddress = getStartAddress;
            // utility function
            function swapBytes(str) {
                let r = "";
                let i = 0;
                for (; i < str.length; i += 2)
                    r = str[i] + str[i + 1] + r;
                pxtc.assert(i == str.length);
                return r;
            }
            function setupInlineAssembly(opts) {
                asmLabels = {};
                let asmSources = opts.sourceFiles.filter(f => pxtc.U.endsWith(f, ".asm"));
                hexfile.asmTotalSource = "";
                let asmIdx = 0;
                for (let f of asmSources) {
                    let src = opts.fileSystem[f];
                    src.replace(/^\s*(\w+):/mg, (f, lbl) => {
                        asmLabels[lbl] = true;
                        return "";
                    });
                    let code = ".section code\n" +
                        "@stackmark func\n" +
                        "@scope user" + asmIdx++ + "\n" +
                        src + "\n" +
                        "@stackempty func\n" +
                        "@scope\n";
                    hexfile.asmTotalSource += code;
                }
            }
            hexfile.setupInlineAssembly = setupInlineAssembly;
            function parseHexBytes(bytes) {
                bytes = bytes.replace(/^[\s:]/, "");
                if (!bytes)
                    return [];
                let outp = [];
                let bytes2 = bytes.replace(/([a-f0-9][a-f0-9])/ig, m => {
                    outp.push(parseInt(m, 16));
                    return "";
                });
                if (bytes2)
                    throw pxtc.oops("bad bytes " + bytes);
                return outp;
            }
            hexfile.parseHexBytes = parseHexBytes;
            function parseHexRecord(bytes) {
                let b = parseHexBytes(bytes);
                return {
                    len: b[0],
                    addr: (b[1] << 8) | b[2],
                    type: b[3],
                    data: b.slice(4, b.length - 1),
                    checksum: b[b.length - 1]
                };
            }
            hexfile.parseHexRecord = parseHexRecord;
            // setup for a particular .hex template file (which corresponds to the C++ source in included packages and the board)
            function flashCodeAlign(opts) {
                return opts.flashCodeAlign || defaultPageSize;
            }
            hexfile.flashCodeAlign = flashCodeAlign;
            // some hex files use '02' records instead of '04' record for addresses. go figure.
            function patchSegmentHex(hex) {
                for (let i = 0; i < hex.length; ++i) {
                    // :020000021000EC
                    if (hex[i][8] == '2') {
                        let m = /^:02....02(....)..$/.exec(hex[i]);
                        pxtc.U.assert(!!m);
                        let upaddr = parseInt(m[1], 16) * 16;
                        pxtc.U.assert((upaddr & 0xffff) == 0);
                        hex[i] = hexBytes([0x02, 0x00, 0x00, 0x04, 0x00, upaddr >> 16]);
                    }
                }
            }
            // see PXT_EXPORTData
            const pointerListMarker = "0108010842424242010801083ed8e98d";
            function setupFor(opts, extInfo) {
                ctx = cachedCtxs.find(c => c.sha == extInfo.sha);
                if (ctx)
                    return;
                ctx = emptyCtx();
                if (cachedCtxs.length > 10)
                    cachedCtxs = [];
                cachedCtxs.push(ctx);
                let funs = extInfo.functions;
                ctx.commBase = extInfo.commBase || 0;
                ctx.sha = extInfo.sha;
                const hexlines = extInfo.hexinfo.hex;
                ctx.hexlines = hexlines;
                if (pxtc.target.nativeType == pxtc.NATIVE_TYPE_VM) {
                    ctx.codeStartAddr = 0;
                    ctx.codeStartAddrPadded = 0;
                    ctx.jmpStartAddr = -1;
                    ctx.jmpStartIdx = -1;
                    for (let f of funs) {
                        ctx.funcInfo[f.name] = f;
                        f.value = 0xffffff;
                    }
                    if (pxtc.target.useESP) {
                        const img = pxt.esp.parseB64(hexlines);
                        const marker = pxtc.U.fromHex(pointerListMarker);
                        const hasMarker = (buf, off) => {
                            for (let i = 0; i < marker.length; ++i)
                                if (buf[off + i] != marker[i])
                                    return false;
                            return true;
                        };
                        const droms = img.segments.filter(s => s.isDROM);
                        pxtc.U.assert(droms.length == 1);
                        let found = false;
                        const drom = droms[0];
                        ctx.codeStartAddr = drom.addr + drom.data.length;
                        ctx.codeStartAddrPadded = (ctx.codeStartAddr + 0xff) & ~0xff;
                        ctx.codePaddingSize = ctx.codeStartAddrPadded - ctx.codeStartAddr;
                        pxt.debug(`user code start: 0x${ctx.codeStartAddrPadded.toString(16)}; dromlen=${drom.data.length} pad=${ctx.codePaddingSize}`);
                        for (let off = 0; off < drom.data.length; off += 0x20) {
                            if (hasMarker(drom.data, off)) {
                                found = true;
                                off += marker.length;
                                const ptroff = off;
                                for (let ptr of extInfo.vmPointers || []) {
                                    if (ptr == "0")
                                        continue;
                                    ptr = ptr.replace(/^&/, "");
                                    ctx.funcInfo[ptr] = {
                                        name: ptr,
                                        argsFmt: [],
                                        value: pxt.HF2.read32(drom.data, off)
                                    };
                                    off += 4;
                                }
                                // store the start of code address at PXT_EXPORTData[4]
                                pxt.HF2.write32(drom.data, ptroff, ctx.codeStartAddrPadded);
                                break;
                            }
                        }
                        pxtc.U.assert(found || (extInfo.vmPointers || []).length == 0);
                        ctx.espInfo = img;
                        ctx.codeStartAddrPadded = 0; // still use .startaddr 0 in asm - that binary is position independent
                    }
                    return;
                }
                if (hexlines.length <= 2) {
                    const bytes = pxtc.U.fromHex(hexlines[0]);
                    if (bytes[2] <= 0x02 && bytes[3] == 0x60) {
                        const off = 0x60000000;
                        const page = 0x1000;
                        const endpadded = (bytes.length + page - 1) & ~(page - 1);
                        // it looks we got a bin file
                        ctx.elfInfo = {
                            template: bytes,
                            imageMemStart: off + endpadded,
                            imageFileStart: endpadded,
                            phOffset: -1000, // don't patch ph-offset in BIN file
                        };
                    }
                    else {
                        ctx.elfInfo = pxt.elf.parse(bytes);
                    }
                    ctx.codeStartAddr = ctx.elfInfo.imageMemStart;
                    ctx.codeStartAddrPadded = ctx.elfInfo.imageMemStart;
                    let jmpIdx = hexlines[0].indexOf(pointerListMarker);
                    if (jmpIdx < 0)
                        pxtc.oops("no jmp table in elf");
                    ctx.jmpStartAddr = jmpIdx / 2;
                    ctx.jmpStartIdx = -1;
                    let ptrs = hexlines[0].slice(jmpIdx + 32, jmpIdx + 32 + funs.length * 8 + 16);
                    readPointers(ptrs);
                    checkFuns();
                    return;
                }
                patchSegmentHex(hexlines);
                let i = 0;
                let upperAddr = "0000";
                let lastAddr = 0;
                let lastIdx = 0;
                ctx.codeStartAddr = 0;
                let hitEnd = () => {
                    if (!ctx.codeStartAddr) {
                        let bytes = parseHexBytes(hexlines[lastIdx]);
                        let missing = (0x10 - ((lastAddr + bytes[0]) & 0xf)) & 0xf;
                        if (missing)
                            if (bytes[2] & 0xf) {
                                let next = lastAddr + bytes[0];
                                let newline = [missing, next >> 8, next & 0xff, 0x00];
                                for (let i = 0; i < missing; ++i)
                                    newline.push(0x00);
                                lastIdx++;
                                hexlines.splice(lastIdx, 0, hexBytes(newline));
                                ctx.codeStartAddr = next + missing;
                            }
                            else {
                                if (bytes[0] != 0x10) {
                                    bytes.pop(); // checksum
                                    bytes[0] = 0x10;
                                    while (bytes.length < 20)
                                        bytes.push(0x00);
                                    hexlines[lastIdx] = hexBytes(bytes);
                                }
                                ctx.codeStartAddr = lastAddr + 16;
                            }
                        else {
                            ctx.codeStartAddr = lastAddr + bytes[0];
                        }
                        ctx.codeStartIdx = lastIdx + 1;
                        const pageSize = flashCodeAlign(opts);
                        ctx.codeStartAddrPadded = (ctx.codeStartAddr & ~(pageSize - 1)) + pageSize;
                        const paddingBytes = ctx.codeStartAddrPadded - ctx.codeStartAddr;
                        pxtc.assert((paddingBytes & 0xf) == 0);
                        ctx.codePaddingSize = paddingBytes;
                    }
                };
                for (; i < hexlines.length; ++i) {
                    let m = /:02000004(....)/.exec(hexlines[i]);
                    if (m) {
                        upperAddr = m[1];
                    }
                    m = /^:..(....)00/.exec(hexlines[i]);
                    if (m) {
                        let newAddr = parseInt(upperAddr + m[1], 16);
                        if (!opts.flashUsableEnd && lastAddr && newAddr - lastAddr > 64 * 1024)
                            hitEnd();
                        if (opts.flashUsableEnd && newAddr >= opts.flashUsableEnd)
                            hitEnd();
                        lastIdx = i;
                        lastAddr = newAddr;
                    }
                    if (/^:00000001/.test(hexlines[i]))
                        hitEnd();
                    // random magic number, which marks the beginning of the array of function pointers in the .hex file
                    // it is defined in pxt-microbit-core
                    m = /^:10....000108010842424242010801083ED8E98D/.exec(hexlines[i]);
                    if (m) {
                        ctx.jmpStartAddr = lastAddr;
                        ctx.jmpStartIdx = i;
                    }
                }
                pxt.debug(`code start: ${ctx.codeStartAddrPadded}, jmptbl: ${ctx.jmpStartAddr}`);
                if (!ctx.jmpStartAddr)
                    pxtc.oops("No hex start");
                if (!ctx.codeStartAddr)
                    pxtc.oops("No hex end");
                ctx.funcInfo = {};
                for (let i = ctx.jmpStartIdx + 1; i < hexlines.length; ++i) {
                    let m = /^:..(....)00(.{4,})/.exec(hexlines[i]);
                    if (!m)
                        continue;
                    readPointers(m[2]);
                    if (funs.length == 0)
                        break;
                }
                checkFuns();
                return;
                function readPointers(s) {
                    let step = opts.shortPointers ? 4 : 8;
                    while (s.length >= step) {
                        let hexb = s.slice(0, step);
                        let value = parseInt(swapBytes(hexb), 16);
                        s = s.slice(step);
                        let inf = funs.shift();
                        if (!inf)
                            break;
                        ctx.funcInfo[inf.name] = inf;
                        if (!value) {
                            pxtc.U.oops("No value for " + inf.name + " / " + hexb);
                        }
                        if (inf.argsFmt.length == 0) {
                            value ^= 1;
                        }
                        else {
                            if (!opts.runtimeIsARM && opts.nativeType == pxtc.NATIVE_TYPE_THUMB && !(value & 1)) {
                                pxtc.U.oops("Non-thumb addr for " + inf.name + " / " + hexb);
                            }
                        }
                        inf.value = value;
                    }
                }
                function checkFuns() {
                    if (funs.length)
                        pxtc.oops("premature EOF in hex file; missing: " + funs.map(f => f.name).join(", "));
                }
            }
            hexfile.setupFor = setupFor;
            function validateShim(funname, shimName, attrs, hasRet, argIsNumber) {
                if (shimName == "TD_ID" || shimName == "TD_NOOP" || shimName == "ENUM_GET")
                    return;
                if (pxtc.U.lookup(asmLabels, shimName))
                    return;
                let nm = `${funname}(...) (shim=${shimName})`;
                let inf = lookupFunc(shimName);
                if (inf) {
                    if (!hasRet) {
                        if (inf.argsFmt[0] != "V")
                            pxtc.U.userError("expecting procedure for " + nm);
                    }
                    else {
                        if (inf.argsFmt[0] == "V")
                            pxtc.U.userError("expecting function for " + nm);
                    }
                    for (let i = 0; i < argIsNumber.length; ++i) {
                        let spec = inf.argsFmt[i + 1];
                        if (!spec)
                            pxtc.U.userError("excessive parameters passed to " + nm);
                    }
                    if (argIsNumber.length != inf.argsFmt.length - 1)
                        pxtc.U.userError(`not enough arguments for ${nm} (got ${argIsNumber.length}; fmt=${inf.argsFmt.join(",")})`);
                }
                else {
                    pxtc.U.userError("function not found: " + nm);
                }
            }
            hexfile.validateShim = validateShim;
            function lookupFunc(name) {
                return ctx.funcInfo[name];
            }
            hexfile.lookupFunc = lookupFunc;
            function lookupFunctionAddr(name) {
                if (name == "_pxt_comm_base")
                    return ctx.commBase;
                let inf = lookupFunc(name);
                if (inf)
                    return inf.value;
                return null;
            }
            hexfile.lookupFunctionAddr = lookupFunctionAddr;
            function hexTemplateHash() {
                let sha = ctx.sha ? ctx.sha.slice(0, 16) : "";
                while (sha.length < 16)
                    sha += "0";
                return sha.toUpperCase();
            }
            hexfile.hexTemplateHash = hexTemplateHash;
            function hexPrelude() {
                return `    .startaddr 0x${ctx.codeStartAddrPadded.toString(16)}\n`;
            }
            hexfile.hexPrelude = hexPrelude;
            function hexBytes(bytes) {
                let chk = 0;
                let r = ":";
                bytes.forEach(b => chk += b);
                bytes.push((-chk) & 0xff);
                bytes.forEach(b => r += ("0" + b.toString(16)).slice(-2));
                return r.toUpperCase();
            }
            hexfile.hexBytes = hexBytes;
            function patchHex(bin, buf, shortForm, useuf2) {
                let myhex = ctx.hexlines.slice(0, ctx.codeStartIdx);
                if (!bin.target.useESP) {
                    let sizeEntry = (buf.length * 2 + 7) >> 3;
                    pxtc.assert(sizeEntry < 64000, "program too large, bytes: " + buf.length * 2);
                    // store the size of the program (in 64 bit words)
                    buf[17] = sizeEntry;
                    // store commSize
                    buf[20] = bin.commSize;
                }
                let zeros = [];
                for (let i = 0; i < ctx.codePaddingSize >> 1; ++i)
                    zeros.push(0);
                buf = zeros.concat(buf);
                let ptr = 0;
                function nextLine(buf, addr) {
                    let bytes = [0x10, (addr >> 8) & 0xff, addr & 0xff, 0];
                    for (let j = 0; j < 8; ++j) {
                        bytes.push((buf[ptr] || 0) & 0xff);
                        bytes.push((buf[ptr] || 0) >>> 8);
                        ptr++;
                    }
                    return bytes;
                }
                // 0x4210 is the version number matching pxt-microbit-core
                let hd = [0x4210, 0, ctx.codeStartAddrPadded & 0xffff, ctx.codeStartAddrPadded >>> 16];
                let tmp = hexTemplateHash();
                for (let i = 0; i < 4; ++i)
                    hd.push(parseInt(swapBytes(tmp.slice(i * 4, i * 4 + 4)), 16));
                let uf2 = useuf2 ? pxtc.UF2.newBlockFile(pxtc.target.uf2Family) : null;
                if (ctx.elfInfo) {
                    let prog = new Uint8Array(buf.length * 2);
                    for (let i = 0; i < buf.length; ++i) {
                        pxt.HF2.write16(prog, i * 2, buf[i]);
                    }
                    let resbuf = pxt.elf.patch(ctx.elfInfo, prog);
                    for (let i = 0; i < hd.length; ++i)
                        pxt.HF2.write16(resbuf, i * 2 + ctx.jmpStartAddr, hd[i]);
                    if (uf2 && !bin.target.switches.rawELF) {
                        let bn = bin.options.name || "pxt";
                        bn = bn.replace(/[^a-zA-Z0-9\-\.]+/g, "_");
                        uf2.filename = "Projects/" + bn + ".elf";
                        pxtc.UF2.writeBytes(uf2, 0, resbuf);
                        return [pxtc.UF2.serializeFile(uf2)];
                    }
                    return [pxtc.U.uint8ArrayToString(resbuf)];
                }
                if (ctx.espInfo) {
                    const img = pxt.esp.cloneStruct(ctx.espInfo);
                    const drom = img.segments.find(s => s.isDROM);
                    let ptr = drom.data.length;
                    const trg = new Uint8Array((ptr + buf.length * 2 + 0xff) & ~0xff);
                    trg.set(drom.data);
                    for (let i = 0; i < buf.length; ++i) {
                        pxt.HF2.write16(trg, ptr, buf[i]);
                        ptr += 2;
                    }
                    drom.data = trg;
                    const resbuf = pxt.esp.toBuffer(img);
                    if (uf2) {
                        pxtc.UF2.writeBytes(uf2, 0, resbuf);
                        saveSourceToUF2(uf2, bin);
                        return [pxtc.UF2.serializeFile(uf2)];
                    }
                    return [pxtc.U.uint8ArrayToString(resbuf)];
                }
                if (uf2) {
                    pxtc.UF2.writeHex(uf2, myhex);
                    pxtc.UF2.writeBytes(uf2, ctx.jmpStartAddr, nextLine(hd, ctx.jmpStartIdx).slice(4));
                    if (bin.checksumBlock) {
                        let bytes = [];
                        for (let w of bin.checksumBlock)
                            bytes.push(w & 0xff, w >> 8);
                        pxtc.UF2.writeBytes(uf2, bin.target.flashChecksumAddr, bytes);
                    }
                }
                else {
                    myhex[ctx.jmpStartIdx] = hexBytes(nextLine(hd, ctx.jmpStartAddr));
                    if (bin.checksumBlock) {
                        pxtc.U.oops("checksum block in HEX not implemented yet");
                    }
                }
                ptr = 0;
                if (shortForm)
                    myhex = [];
                let addr = ctx.codeStartAddr;
                let upper = (addr - 16) >> 16;
                while (ptr < buf.length) {
                    if (uf2) {
                        pxtc.UF2.writeBytes(uf2, addr, nextLine(buf, addr).slice(4));
                    }
                    else {
                        if ((addr >> 16) != upper) {
                            upper = addr >> 16;
                            myhex.push(hexBytes([0x02, 0x00, 0x00, 0x04, upper >> 8, upper & 0xff]));
                        }
                        myhex.push(hexBytes(nextLine(buf, addr)));
                    }
                    addr += 16;
                }
                if (!shortForm) {
                    let app = ctx.hexlines.slice(ctx.codeStartIdx);
                    if (uf2)
                        pxtc.UF2.writeHex(uf2, app);
                    else
                        pxtc.Util.pushRange(myhex, app);
                }
                if (!uf2 && bin.target.moveHexEof) {
                    while (!myhex[myhex.length - 1])
                        myhex.pop();
                    if (myhex[myhex.length - 1] == ":00000001FF")
                        myhex.pop();
                }
                if (bin.packedSource) {
                    if (uf2) {
                        saveSourceToUF2(uf2, bin);
                    }
                    else {
                        let addr = 0;
                        for (let i = 0; i < bin.packedSource.length; i += 16) {
                            let bytes = [0x10, (addr >> 8) & 0xff, addr & 0xff, 0x0E];
                            for (let j = 0; j < 16; ++j) {
                                bytes.push((bin.packedSource.charCodeAt(i + j) || 0) & 0xff);
                            }
                            myhex.push(hexBytes(bytes));
                            addr += 16;
                        }
                    }
                }
                if (!uf2 && bin.target.moveHexEof)
                    myhex.push(":00000001FF");
                if (uf2)
                    return [pxtc.UF2.serializeFile(uf2)];
                else
                    return myhex;
            }
            hexfile.patchHex = patchHex;
        })(hexfile = pxtc.hexfile || (pxtc.hexfile = {}));
        function saveSourceToUF2(uf2, bin) {
            if (!bin.packedSource)
                return;
            let addr = (uf2.currPtr + 0x1000) & ~0xff;
            let buf = new Uint8Array(256);
            for (let ptr = 0; ptr < bin.packedSource.length; ptr += 256) {
                for (let i = 0; i < 256; ++i)
                    buf[i] = bin.packedSource.charCodeAt(ptr + i);
                pxtc.UF2.writeBytes(uf2, addr, buf, pxtc.UF2.UF2_FLAG_NOFLASH);
                addr += 256;
            }
        }
        function hexDump(bytes, startOffset = 0) {
            function toHex(n, len = 8) {
                let r = n.toString(16);
                while (r.length < len)
                    r = "0" + r;
                return r;
            }
            let r = "";
            for (let i = 0; i < bytes.length; i += 16) {
                r += toHex(startOffset + i) + ": ";
                let t = "";
                for (let j = 0; j < 16; j++) {
                    if ((j & 3) == 0)
                        r += " ";
                    let v = bytes[i + j];
                    if (v == null) {
                        r += "   ";
                        continue;
                    }
                    r += toHex(v, 2) + " ";
                    if (32 <= v && v < 127)
                        t += String.fromCharCode(v);
                    else
                        t += ".";
                }
                r += " " + t + "\n";
            }
            return r;
        }
        pxtc.hexDump = hexDump;
        function asmline(s) {
            if (s.indexOf("\n") >= 0) {
                s = s.replace(/^\s*/mg, "")
                    .replace(/^(.*)$/mg, (l, x) => {
                    if ((x[0] == ";" && x[1] == " ") || /:\*$/.test(x))
                        return x;
                    else
                        return "    " + x;
                });
                return s + "\n";
            }
            else {
                if (!/(^[\s;])|(:$)/.test(s))
                    s = "    " + s;
                return s + "\n";
            }
        }
        pxtc.asmline = asmline;
        function emitStrings(snippets, bin) {
            // ifaceMembers are already sorted alphabetically
            // here we make sure that the pointers to them are also sorted alphabetically
            // by emitting them in order and before everything else
            const keys = pxtc.U.unique(bin.ifaceMembers.concat(Object.keys(bin.strings)), s => s);
            for (let s of keys) {
                bin.otherLiterals.push(snippets.string_literal(bin.strings[s], s));
            }
            for (let data of Object.keys(bin.doubles)) {
                let lbl = bin.doubles[data];
                bin.otherLiterals.push(`
.balign 4
${lbl}: ${snippets.obj_header("pxt::number_vt")}
        .hex ${data}
`);
            }
            for (let data of Object.keys(bin.hexlits)) {
                bin.otherLiterals.push(snippets.hex_literal(bin.hexlits[data], data));
                bin.otherLiterals.push();
            }
        }
        function firstMethodOffset() {
            // 4 words header
            // 4 or 2 mem mgmt methods
            // 1 toString
            return 4 + 4 + 1;
        }
        pxtc.firstMethodOffset = firstMethodOffset;
        const primes = [
            21078089, 22513679, 15655169, 18636881, 19658081, 21486649, 21919277, 20041213, 20548751,
            16180187, 18361627, 19338023, 19772677, 16506547, 23530697, 22998697, 21225203, 19815283,
            23679599, 19822889, 21136133, 19540043, 21837031, 18095489, 23924267, 23434627, 22582379,
            21584111, 22615171, 23403001, 19640683, 19998031, 18460439, 20105387, 17595791, 16482043,
            23199959, 18881641, 21578371, 22765747, 20170273, 16547639, 16434589, 21435019, 20226751,
            19506731, 21454393, 23224541, 23431973, 23745511,
        ];
        pxtc.vtLookups = 3;
        function computeHashMultiplier(nums) {
            let shift = 32;
            pxtc.U.assert(pxtc.U.unique(nums, v => "" + v).length == nums.length, "non unique");
            for (let sz = 2;; sz = sz << 1) {
                shift--;
                if (sz < nums.length)
                    continue;
                let minColl = -1;
                let minMult = -1;
                let minArr;
                for (let mult0 of primes) {
                    let mult = (mult0 << 8) | shift;
                    let arr = new Uint16Array(sz + pxtc.vtLookups + 1);
                    pxtc.U.assert((arr.length & 1) == 0);
                    let numColl = 0;
                    let vals = [];
                    for (let n of nums) {
                        pxtc.U.assert(n > 0);
                        let k = Math.imul(n, mult) >>> shift;
                        vals.push(k);
                        let found = false;
                        for (let l = 0; l < pxtc.vtLookups; l++) {
                            if (!arr[k + l]) {
                                found = true;
                                arr[k + l] = n;
                                break;
                            }
                            numColl++;
                        }
                        if (!found) {
                            numColl = -1;
                            break;
                        }
                    }
                    if (minColl == -1 || minColl > numColl) {
                        minColl = numColl;
                        minMult = mult;
                        minArr = arr;
                    }
                }
                if (minColl >= 0) {
                    return {
                        mult: minMult,
                        mapping: minArr,
                        size: sz
                    };
                }
            }
        }
        pxtc.computeHashMultiplier = computeHashMultiplier;
        function vtableToAsm(info, opts, bin) {
            /*
            uint16_t numbytes;
            ValType objectType;
            uint8_t magic;
            PVoid *ifaceTable;
            BuiltInType classNo;
            uint16_t reserved;
            uint32_t ifaceHashMult;
            PVoid methods[2 or 4];
            */
            const ifaceInfo = computeHashMultiplier(info.itable.map(e => e.idx));
            //if (info.itable.length == 0)
            //    ifaceInfo.mult = 0
            let ptrSz = pxtc.target.shortPointers ? ".short" : ".word";
            let s = `
        .balign 4
${info.id}_VT:
        .short ${info.allfields.length * 4 + 4}  ; size in bytes
        .byte ${pxt.ValTypeObject}, ${pxt.VTABLE_MAGIC} ; magic
        ${ptrSz} ${info.id}_IfaceVT
        .short ${info.classNo} ; class-id
        .short 0 ; reserved
        .word ${ifaceInfo.mult} ; hash-mult
`;
            let addPtr = (n) => {
                if (n != "0")
                    n += "@fn";
                s += `        ${ptrSz} ${n}\n`;
            };
            addPtr("pxt::RefRecord_destroy");
            addPtr("pxt::RefRecord_print");
            addPtr("pxt::RefRecord_scan");
            addPtr("pxt::RefRecord_gcsize");
            let toStr = info.toStringMethod;
            addPtr(toStr ? toStr.vtLabel() : "0");
            for (let m of info.vtable) {
                addPtr(m.label() + "_nochk");
            }
            // See https://makecode.microbit.org/15593-01779-41046-40599 for Thumb binary search.
            s += `
        .balign ${pxtc.target.shortPointers ? 2 : 4}
${info.id}_IfaceVT:
`;
            const descSize = 8;
            const zeroOffset = ifaceInfo.mapping.length * 2;
            let descs = "";
            let offset = zeroOffset;
            let offsets = {};
            for (let e of info.itable) {
                offsets[e.idx + ""] = offset;
                const desc = !e.proc ? 0 : e.proc.isGetter() ? 1 : 2;
                descs += `  .short ${e.idx}, ${desc} ; ${e.name}\n`;
                descs += `  .word ${e.proc ? e.proc.vtLabel() + "@fn" : e.info}\n`;
                offset += descSize;
                if (e.setProc) {
                    descs += `  .short ${e.idx}, 0 ; set ${e.name}\n`;
                    descs += `  .word ${e.setProc.vtLabel()}@fn\n`;
                    offset += descSize;
                }
            }
            descs += "  .word 0, 0 ; the end\n";
            offset += descSize;
            let map = ifaceInfo.mapping;
            for (let i = 0; i < map.length; ++i) {
                bin.itEntries++;
                if (map[i])
                    bin.itFullEntries++;
            }
            // offsets are relative to the position in the array
            s += "  .short " + pxtc.U.toArray(map).map((e, i) => (offsets[e + ""] || zeroOffset) - (i * 2)).join(", ") + "\n";
            s += descs;
            s += "\n";
            return s;
        }
        pxtc.vtableToAsm = vtableToAsm;
        const systemPerfCounters = [
            "GC"
        ];
        function asmHeader(bin) {
            return `; start
${hexfile.hexPrelude()}
    .hex 708E3B92C615A841C49866C975EE5197 ; magic number
    .hex ${hexfile.hexTemplateHash()} ; hex template hash
    .hex 873266330af9dbdb ; replaced in binary by program hash
`;
        }
        function serialize(bin, opts) {
            let asmsource = `
    .short ${bin.globalsWords}   ; num. globals
    .short 0 ; patched with number of 64 bit words resulting from assembly
    .word _pxt_config_data
    .short 0 ; patched with comm section size
    .short ${bin.nonPtrGlobals} ; number of globals that are not pointers (they come first)
    .word _pxt_iface_member_names
    .word _pxt_lambda_trampoline@fn
    .word _pxt_perf_counters
    .word _pxt_restore_exception_state@fn
    .word ${bin.emitString(bin.getTitle())} ; name
`;
            let snippets = null;
            snippets = new pxtc.ThumbSnippets();
            const perfCounters = bin.setPerfCounters(systemPerfCounters);
            bin.procs.forEach(p => {
                let p2a = new pxtc.ProctoAssembler(snippets, bin, p);
                asmsource += "\n" + p2a.getAssembly() + "\n";
            });
            let helpers = new pxtc.ProctoAssembler(snippets, bin, null);
            helpers.emitHelpers();
            asmsource += "\n" + helpers.getAssembly() + "\n";
            asmsource += hexfile.asmTotalSource; // user-supplied asm
            asmsource += "_code_end:\n\n";
            pxtc.U.iterMap(bin.codeHelpers, (code, lbl) => {
                asmsource += `    .section code\n${lbl}:\n${code}\n`;
            });
            asmsource += snippets.arithmetic();
            asmsource += "_helpers_end:\n\n";
            bin.usedClassInfos.forEach(info => {
                asmsource += vtableToAsm(info, opts, bin);
            });
            asmsource += `\n.balign 4\n_pxt_iface_member_names:\n`;
            asmsource += `    .word ${bin.ifaceMembers.length}\n`;
            let idx = 0;
            for (let d of bin.ifaceMembers) {
                let lbl = bin.emitString(d);
                asmsource += `    .word ${lbl}  ; ${idx++} .${d}\n`;
            }
            asmsource += `    .word 0\n`;
            asmsource += "_vtables_end:\n\n";
            asmsource += `\n.balign 4\n_pxt_config_data:\n`;
            const cfg = bin.res.configData || [];
            // asmsource += `    .word ${cfg.length}, 0 ; num. entries`
            for (let d of cfg) {
                asmsource += `    .word ${d.key}, ${d.value}  ; ${d.name}=${d.value}\n`;
            }
            asmsource += `    .word 0\n\n`;
            emitStrings(snippets, bin);
            asmsource += bin.otherLiterals.join("");
            asmsource += `\n.balign 4\n.section code\n_pxt_perf_counters:\n`;
            asmsource += `    .word ${perfCounters.length}\n`;
            let strs = "";
            for (let i = 0; i < perfCounters.length; ++i) {
                let lbl = ".perf" + i;
                asmsource += `    .word ${lbl}\n`;
                strs += `${lbl}: .string ${JSON.stringify(perfCounters[i])}\n`;
            }
            asmsource += strs;
            asmsource += "_literals_end:\n";
            return asmsource;
        }
        function processorInlineAssemble(target, src) {
            let b = mkProcessorFile(target);
            b.disablePeepHole = true;
            b.emit(src);
            throwAssemblerErrors(b);
            let res = [];
            for (let i = 0; i < b.buf.length; i += 2) {
                res.push((((b.buf[i + 1] || 0) << 16) | b.buf[i]) >>> 0);
            }
            return res;
        }
        pxtc.processorInlineAssemble = processorInlineAssemble;
        function mkProcessorFile(target) {
            let b;
            if (target.nativeType == pxtc.NATIVE_TYPE_VM)
                b = new pxtc.assembler.VMFile(new pxtc.vm.VmProcessor(target));
            else
                b = new pxtc.assembler.File(new pxtc.thumb.ThumbProcessor());
            b.ei.testAssembler(); // just in case
            if (target.switches.noPeepHole)
                b.disablePeepHole = true;
            b.lookupExternalLabel = hexfile.lookupFunctionAddr;
            b.normalizeExternalLabel = s => {
                let inf = hexfile.lookupFunc(s);
                if (inf)
                    return inf.name;
                return s;
            };
            // b.throwOnError = true;
            return b;
        }
        function throwAssemblerErrors(b) {
            if (b.errors.length > 0) {
                let userErrors = "";
                b.errors.forEach(e => {
                    let m = /^user(\d+)/.exec(e.scope);
                    if (m) {
                        // This generally shouldn't happen, but it may for certin kind of global
                        // errors - jump range and label redefinitions
                        let no = parseInt(m[1]); // TODO lookup assembly file name
                        userErrors += pxtc.U.lf("At inline assembly:\n");
                        userErrors += e.message;
                    }
                });
                if (userErrors) {
                    //TODO
                    console.log(pxtc.U.lf("errors in inline assembly"));
                    console.log(userErrors);
                    throw new Error(b.errors[0].message);
                }
                else {
                    throw new Error(b.errors[0].message);
                }
            }
        }
        let peepDbg = false;
        function assemble(target, bin, src) {
            let b = mkProcessorFile(target);
            b.emit(src);
            src = `; Interface tables: ${bin.itFullEntries}/${bin.itEntries} (${Math.round(100 * bin.itFullEntries / bin.itEntries)}%)\n` +
                `; Virtual methods: ${bin.numVirtMethods} / ${bin.numMethods}\n` +
                b.getSource(!peepDbg, bin.numStmts, target.flashEnd);
            throwAssemblerErrors(b);
            return {
                src: src,
                buf: b.buf,
                thumbFile: b
            };
        }
        pxtc.assemble = assemble;
        function addSource(blob) {
            let res = "";
            for (let i = 0; i < blob.length; ++i) {
                let v = blob.charCodeAt(i) & 0xff;
                if (v <= 0xf)
                    res += "0" + v.toString(16);
                else
                    res += v.toString(16);
            }
            return `
    .balign 16
_stored_program: .hex ${res}
`;
        }
        function packSource(meta, binstring) {
            let metablob = pxtc.Util.toUTF8(meta);
            let totallen = metablob.length + binstring.length;
            let res = "\x41\x14\x0E\x2F\xB8\x2F\xA2\xBB";
            res += pxtc.U.uint8ArrayToString([
                metablob.length & 0xff, metablob.length >> 8,
                binstring.length & 0xff, binstring.length >> 8,
                0, 0, 0, 0
            ]);
            res += metablob;
            res += binstring;
            if (res.length % 2)
                res += "\x00";
            return res;
        }
        function assembleAndPatch(src, bin, opts, cres) {
            const dummy = opts.extinfo.disabledDeps;
            if (dummy) {
                src =
                    `${hexfile.hexPrelude()}\n` +
                        `; compilation disabled on this variant due to ${opts.extinfo.disabledDeps}\n` +
                        `.hex 718E3B92C615A841C49866C975EE5197\n` +
                        `.string "${opts.extinfo.disabledDeps}"`;
            }
            else {
                src = asmHeader(bin) + src;
            }
            if (opts.embedBlob) {
                bin.packedSource = packSource(opts.embedMeta, ts.pxtc.decodeBase64(opts.embedBlob));
                // TODO more dynamic check for source size
                if (!bin.target.noSourceInFlash && bin.packedSource.length < 40000) {
                    src += addSource(bin.packedSource);
                    bin.packedSource = null; // no need to append anymore
                }
            }
            const checksumWords = 8;
            const pageSize = hexfile.flashCodeAlign(opts.target);
            if (!dummy && opts.target.flashChecksumAddr) {
                let k = 0;
                while (pageSize > (1 << k))
                    k++;
                let endMarker = parseInt(hexfile.hexTemplateHash().slice(8, 16), 16);
                const progStart = hexfile.getStartAddress() / pageSize;
                endMarker = (endMarker & 0xffffff00) | k;
                let templBeg = 0;
                let templSize = progStart;
                // we exclude the checksum block from the template
                if (opts.target.flashChecksumAddr < hexfile.getStartAddress()) {
                    templBeg = Math.ceil((opts.target.flashChecksumAddr + 32) / pageSize);
                    templSize -= templBeg;
                }
                src += `
    .balign 4
__end_marker:
    .word ${endMarker}

; ------- this will get removed from the final binary ------
__flash_checksums:
    .word 0x87eeb07c ; magic
    .word __end_marker ; end marker position
    .word ${endMarker} ; end marker
    ; template region
    .short ${templBeg}, ${templSize}
    .word 0x${hexfile.hexTemplateHash().slice(0, 8)}
    ; user region
    .short ${progStart}, 0xffff
    .hex 87326633 ; replaced later
    .word 0x0 ; terminator
`;
            }
            const prefix = opts.extinfo.outputPrefix || "";
            bin.writeFile(prefix + pxtc.BINARY_ASM, src);
            const res = assemble(opts.target, bin, src);
            if (res.thumbFile.commPtr)
                bin.commSize = res.thumbFile.commPtr - hexfile.getCommBase();
            if (res.src)
                bin.writeFile(prefix + pxtc.BINARY_ASM, res.src);
            if (dummy) {
                writeOutput();
                return;
            }
            const cfg = cres.configData || [];
            // When BOOTLOADER_BOARD_ID is present in project, it means it's meant as configuration
            // for bootloader. Spit out config.c file in that case, so it can be included in bootloader.
            if (cfg.some(e => e.name == "BOOTLOADER_BOARD_ID")) {
                let c = `const uint32_t configData[] = {\n`;
                c += `    0x1e9e10f1, 0x20227a79, // magic\n`;
                c += `    ${cfg.length}, 0, // num. entries; reserved\n`;
                for (let e of cfg) {
                    c += `    ${e.key}, 0x${e.value.toString(16)}, // ${e.name}\n`;
                }
                c += "    0, 0\n};\n";
                bin.writeFile(prefix + "config.c", c);
            }
            if (res.buf) {
                const buf = res.buf;
                let binbuf = "";
                for (let i = 0; i < buf.length; ++i)
                    binbuf += String.fromCharCode(buf[i] & 0xff, buf[i] >> 8);
                const sha = pxtc.U.sha256(binbuf).slice(0, 16);
                const shawords = pxtc.U.range(4).map(k => parseInt(sha.slice(k * 2, k * 2 + 2), 16));
                pxtc.U.assert(buf[12] == 0x3287);
                for (let i = 0; i < shawords.length; ++i)
                    buf[12 + i] = shawords[i];
                if (opts.target.flashChecksumAddr) {
                    let pos = res.thumbFile.lookupLabel("__flash_checksums") / 2;
                    pxtc.U.assert(pos == buf.length - checksumWords * 2);
                    let chk = buf.slice(buf.length - checksumWords * 2);
                    buf.splice(buf.length - checksumWords * 2, checksumWords * 2);
                    let len = Math.ceil(buf.length * 2 / pageSize);
                    pxtc.U.assert(chk[chk.length - 4] == 0x3287);
                    chk[chk.length - 4] = shawords[0];
                    chk[chk.length - 3] = shawords[1];
                    chk[chk.length - 5] = len;
                    bin.checksumBlock = chk;
                }
                writeOutput();
            }
            if (!cres.procDebugInfo) {
                for (let bkpt of cres.breakpoints) {
                    let lbl = pxtc.U.lookup(res.thumbFile.getLabels(), "__brkp_" + bkpt.id);
                    if (lbl != null)
                        bkpt.binAddr = lbl;
                }
                for (let proc of bin.procs) {
                    proc.fillDebugInfo(res.thumbFile);
                }
                cres.procDebugInfo = bin.procs.map(p => p.debugInfo);
                if (bin.target.switches.size) {
                    const csv = [];
                    // "filename,line,name,type,size\n"
                    for (const proc of bin.procs) {
                        const info = ts.pxtc.nodeLocationInfo(proc.action);
                        const line = [
                            info.fileName.replace("pxt_modules/", ""),
                            pxtc.getDeclName(proc.action),
                            proc.debugInfo.size,
                            "function",
                            info.line + 1
                        ];
                        csv.push(toCSV(line));
                    }
                    csv.sort();
                    csv.unshift("filename,name,size,type,line");
                    bin.writeFile(prefix + "size.csv", csv.join("\n"));
                }
            }
            function writeOutput() {
                if (!pxt.isOutputText(pxtc.target)) {
                    const myhex = ts.pxtc.encodeBase64(hexfile.patchHex(bin, res.buf, false, !!pxtc.target.useUF2)[0]);
                    bin.writeFile(prefix + pxt.outputName(pxtc.target), myhex);
                }
                else {
                    const myhex = hexfile.patchHex(bin, res.buf, false, false).join("\r\n") + "\r\n";
                    bin.writeFile(prefix + pxt.outputName(pxtc.target), myhex);
                }
            }
        }
        function toCSV(elts) {
            return elts.map(s => `"${s}"`).join(",");
        }
        function processorEmit(bin, opts, cres) {
            const src = serialize(bin, opts);
            const opts0 = pxtc.U.flatClone(opts);
            // normally, this would already have been done, but if the main variant
            // is disabled, another variant may be set up
            hexfile.setupFor(opts.target, opts.extinfo || pxtc.emptyExtInfo());
            assembleAndPatch(src, bin, opts, cres);
            const otherVariants = opts0.otherMultiVariants || [];
            if (otherVariants.length)
                try {
                    for (let other of otherVariants) {
                        const localOpts = pxtc.U.flatClone(opts0);
                        localOpts.extinfo = other.extinfo;
                        other.target.isNative = true;
                        localOpts.target = other.target;
                        hexfile.setupFor(localOpts.target, localOpts.extinfo);
                        assembleAndPatch(src, bin, localOpts, cres);
                    }
                }
                finally {
                    hexfile.setupFor(opts0.target, opts0.extinfo);
                }
        }
        pxtc.processorEmit = processorEmit;
        pxtc.validateShim = hexfile.validateShim;
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        function getHelpForKeyword(word, isPython) {
            // TODO: Fill these in for TypeScript
            const tsHelp = {
                "abstract": null,
                "any": null,
                "as": null,
                "break": null,
                "case": null,
                "catch": null,
                "class": null,
                "continue": null,
                "const": null,
                "constructor": null,
                "debugger": null,
                "declare": null,
                "delete": null,
                "do": null,
                "else": null,
                "enum": null,
                "export": null,
                "extends": null,
                "false": lf("Represents the negative outcome of a logical expression"),
                "finally": null,
                "for": null,
                "from": null,
                "function": null,
                "get": null,
                "if": null,
                "implements": null,
                "in": null,
                "instanceof": null,
                "interface": null,
                "is": null,
                "let": null,
                "namespace": null,
                "new": null,
                "null": null,
                "private": null,
                "protected": null,
                "public": null,
                "return": null,
                "set": null,
                "static": null,
                "super": null,
                "switch": null,
                "this": null,
                "throw": null,
                "true": lf("Represents the positive outcome of a logical expression"),
                "try": null,
                "type": null,
                "typeof": null,
                "undefined": null,
                "void": null,
                "while": null,
                "with": null,
                "of": null
            };
            if (isPython) {
                // We don't actually support all of these! I just copied over all
                // of the reserved words
                const pyHelp = {
                    "True": tsHelp["true"],
                    "False": tsHelp["false"],
                    "None": null,
                    "abs": null,
                    "all": null,
                    "any": null,
                    "ascii": null,
                    "bin": null,
                    "bool": null,
                    "bytearray": null,
                    "bytes": null,
                    "callable": null,
                    "chr": null,
                    "classmethod": null,
                    "compile": null,
                    "complex": null,
                    "copyright": null,
                    "credits": null,
                    "delattr": null,
                    "dict": null,
                    "dir": null,
                    "divmod": null,
                    "enumerate": null,
                    "eval": null,
                    "exec": null,
                    "exit": null,
                    "filter": null,
                    "float": null,
                    "format": null,
                    "frozenset": null,
                    "getattr": null,
                    "globals": null,
                    "hasattr": null,
                    "hash": null,
                    "help": null,
                    "hex": null,
                    "id": null,
                    "input": null,
                    "int": null,
                    "isinstance": null,
                    "issubclass": null,
                    "iter": null,
                    "len": null,
                    "license": null,
                    "list": null,
                    "locals": null,
                    "map": null,
                    "max": null,
                    "memoryview": null,
                    "min": null,
                    "next": null,
                    "object": null,
                    "oct": null,
                    "open": null,
                    "ord": null,
                    "pow": null,
                    "print": null,
                    "property": null,
                    "quit": null,
                    "range": null,
                    "repr": null,
                    "reversed": null,
                    "round": null,
                    "set": null,
                    "setattr": null,
                    "slice": null,
                    "sorted": null,
                    "staticmethod": null,
                    "str": null,
                    "sum": null,
                    "super": null,
                    "tuple": null,
                    "type": null,
                    "vars": null,
                };
                return pyHelp[word];
            }
            else {
                return tsHelp[word];
            }
        }
        pxtc.getHelpForKeyword = getHelpForKeyword;
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        class LSHost {
            constructor(p) {
                this.p = p;
            }
            getCompilationSettings() {
                const opts = this.p.getCompilerOptions();
                opts.noLib = true;
                return opts;
            }
            getNewLine() { return "\n"; }
            getScriptFileNames() {
                return this.p.getSourceFiles().map(f => f.fileName);
            }
            getScriptVersion(fileName) {
                return "0";
            }
            getScriptSnapshot(fileName) {
                const f = this.p.getSourceFile(fileName);
                return {
                    getLength: () => f.getFullText().length,
                    getText: () => f.getFullText(),
                    getChangeRange: () => undefined
                };
            }
            getCurrentDirectory() { return "."; }
            getDefaultLibFileName(options) { return ""; }
            useCaseSensitiveFileNames() { return true; }
        }
        pxtc.LSHost = LSHost;
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
var ts;
(function (ts_1) {
    var pxtc;
    (function (pxtc) {
        var service;
        (function (service) {
            // these weights dictate the relative ordering of certain results in the completion
            const COMPLETION_KEYWORD_WEIGHT = 0;
            const COMPLETION_DEFAULT_WEIGHT = 1;
            const COMPLETION_IN_SCOPE_VAR_WEIGHT = 5;
            const COMPLETION_MATCHING_PARAM_TYPE_WEIGHT = 10;
            function getCallSymbol(callExp) {
                var _a, _b;
                const qName = (_b = (_a = callExp === null || callExp === void 0 ? void 0 : callExp.pxt) === null || _a === void 0 ? void 0 : _a.callInfo) === null || _b === void 0 ? void 0 : _b.qName;
                const api = service.lastApiInfo.apis.byQName[qName];
                return api;
            }
            service.getCallSymbol = getCallSymbol;
            function getParameter(callSym, paramIdx, blocksInfo) {
                if (!callSym || paramIdx < 0)
                    return undefined;
                const paramDesc = callSym.parameters[paramIdx];
                let result = paramDesc;
                // check if this parameter has a shadow block, if so use the type from that instead
                if (callSym.attributes._def) {
                    const blockParams = callSym.attributes._def.parameters;
                    const blockParam = blockParams[paramIdx];
                    const shadowId = blockParam.shadowBlockId;
                    if (shadowId) {
                        const shadowBlk = blocksInfo.blocksById[shadowId];
                        const shadowApi = service.lastApiInfo.apis.byQName[shadowBlk.qName];
                        const isPassThrough = shadowApi.attributes.shim === "TD_ID";
                        if (isPassThrough && shadowApi.parameters.length === 1) {
                            result = shadowApi.parameters[0];
                        }
                    }
                }
                return result;
            }
            service.getParameter = getParameter;
            function getApisForTsType(pxtType, location, tc, symbols, isEnum = false) {
                // any apis that return this type?
                // TODO: if this becomes expensive, this can be cached between calls since the same
                // return type is likely to occur over and over.
                const apisByRetType = {};
                symbols.forEach(i => {
                    var _a, _b;
                    let retType = i.symbol.retType;
                    // special case for enum members and enum members exported as constants,
                    // which have the return type 'EnumName.MemberName'. we want to match 'EnumName'
                    if (isEnum) {
                        if (i.symbol.kind == 7 /* EnumMember */) {
                            retType = i.symbol.namespace;
                        }
                        else if (i.symbol.kind == 4 /* Variable */) {
                            const enumParts = (_b = (_a = i.symbol.attributes) === null || _a === void 0 ? void 0 : _a.enumIdentity) === null || _b === void 0 ? void 0 : _b.split(".");
                            if ((enumParts === null || enumParts === void 0 ? void 0 : enumParts.length) > 1)
                                retType = enumParts[0];
                        }
                    }
                    apisByRetType[retType] = [...(apisByRetType[retType] || []), i];
                });
                const retApis = apisByRetType[pxtType] || [];
                // any enum members?
                let enumVals = [];
                for (let r of retApis) {
                    const asTsEnum = getTsSymbolFromPxtSymbol(r.symbol, location, ts_1.SymbolFlags.Enum);
                    if (asTsEnum) {
                        const enumType = tc.getTypeOfSymbolAtLocation(asTsEnum, location);
                        const mems = pxtc.getEnumMembers(tc, enumType);
                        const enumValQNames = mems.map(e => pxtc.enumMemberToQName(tc, e));
                        const symbols = enumValQNames.map(n => service.lastApiInfo.apis.byQName[n]);
                        enumVals = [...enumVals, ...symbols];
                    }
                }
                return [...retApis, ...completionSymbols(enumVals, COMPLETION_DEFAULT_WEIGHT)];
            }
            service.getApisForTsType = getApisForTsType;
            function getBasicKindDefault(kind, isPython) {
                switch (kind) {
                    case pxtc.SK.StringKeyword: return "\"\"";
                    case pxtc.SK.NumberKeyword: return "0";
                    case pxtc.SK.BooleanKeyword: return isPython ? "False" : "false";
                    case pxtc.SK.ArrayType: return "[]";
                    case pxtc.SK.NullKeyword: return isPython ? "None" : "null";
                    default:
                        return undefined;
                }
            }
            service.getBasicKindDefault = getBasicKindDefault;
            function tsSymbolToPxtSymbolKind(ts) {
                if (ts.flags & ts_1.SymbolFlags.Variable)
                    return 4 /* Variable */;
                if (ts.flags & ts_1.SymbolFlags.Class)
                    return 8 /* Class */;
                if (ts.flags & ts_1.SymbolFlags.Enum)
                    return 6 /* Enum */;
                if (ts.flags & ts_1.SymbolFlags.EnumMember)
                    return 7 /* EnumMember */;
                if (ts.flags & ts_1.SymbolFlags.Method)
                    return 1 /* Method */;
                if (ts.flags & ts_1.SymbolFlags.Module)
                    return 5 /* Module */;
                if (ts.flags & ts_1.SymbolFlags.Property)
                    return 2 /* Property */;
                return 0 /* None */;
            }
            service.tsSymbolToPxtSymbolKind = tsSymbolToPxtSymbolKind;
            function makePxtSymbolFromKeyword(keyword) {
                // TODO: since keywords aren't exactly symbols, consider using a different
                //       type than "SymbolInfo" to carry auto completion information.
                //       Some progress on this exists here: dazuniga/completionitem_refactor
                let sym = {
                    kind: 0 /* None */,
                    name: keyword,
                    pyName: keyword,
                    qName: keyword,
                    pyQName: keyword,
                    namespace: "",
                    attributes: {
                        callingConvention: 0 /* Plain */,
                        paramDefl: {},
                    },
                    fileName: pxt.MAIN_TS,
                    parameters: [],
                    retType: "any",
                };
                return sym;
            }
            service.makePxtSymbolFromKeyword = makePxtSymbolFromKeyword;
            function makePxtSymbolFromTsSymbol(tsSym, tsType) {
                var _a, _b;
                // TODO: get proper filename, fill out parameter info, handle qualified names
                //      none of these are needed for JS auto-complete which is the primary
                //      use case for this.
                let qname = tsSym.getName();
                let match = /(.*)\.(.*)/.exec(qname);
                let name = match ? match[2] : qname;
                let ns = match ? match[1] : "";
                let typeName = (_b = (_a = tsType.getSymbol()) === null || _a === void 0 ? void 0 : _a.getName()) !== null && _b !== void 0 ? _b : "any";
                let sym = {
                    kind: tsSymbolToPxtSymbolKind(tsSym),
                    name: name,
                    pyName: name,
                    qName: qname,
                    pyQName: qname,
                    namespace: ns,
                    attributes: {
                        callingConvention: 0 /* Plain */,
                        paramDefl: {},
                    },
                    fileName: pxt.MAIN_TS,
                    parameters: [],
                    retType: typeName,
                };
                return sym;
            }
            service.makePxtSymbolFromTsSymbol = makePxtSymbolFromTsSymbol;
            function getPxtSymbolFromTsSymbol(tsSym, apiInfo, tc) {
                if (tsSym) {
                    return apiInfo.byQName[tc.getFullyQualifiedName(tsSym)];
                }
                return undefined;
            }
            service.getPxtSymbolFromTsSymbol = getPxtSymbolFromTsSymbol;
            function compareCompletionSymbols(a, b) {
                if (a.weight !== b.weight) {
                    return b.weight - a.weight;
                }
                return pxtc.compareSymbols(a.symbol, b.symbol);
            }
            service.compareCompletionSymbols = compareCompletionSymbols;
            function completionSymbol(symbol, weight) {
                return { symbol, weight };
            }
            service.completionSymbol = completionSymbol;
            function completionSymbols(symbols, weight) {
                return symbols.map(s => completionSymbol(s, weight));
            }
            service.completionSymbols = completionSymbols;
            function getNodeAndSymbolAtLocation(program, filename, position, apiInfo) {
                const source = program.getSourceFile(filename);
                const checker = program.getTypeChecker();
                const node = pxtc.findInnerMostNodeAtPosition(source, position);
                if (node) {
                    const symbol = checker.getSymbolAtLocation(node);
                    if (symbol) {
                        let pxtSym = getPxtSymbolFromTsSymbol(symbol, apiInfo, checker);
                        return [node, pxtSym];
                    }
                }
                return null;
            }
            service.getNodeAndSymbolAtLocation = getNodeAndSymbolAtLocation;
            function tsTypeToPxtTypeString(t, tc) {
                var _a;
                if (t.flags & ts_1.TypeFlags.NumberLiteral) {
                    return "Number";
                }
                else if (t.flags & ts_1.TypeFlags.StringLiteral) {
                    return "String";
                }
                else if (t.flags & ts_1.TypeFlags.BooleanLiteral) {
                    return "Boolean";
                }
                const tcString = tc.typeToString(t);
                const primativeToQname = {
                    "number": "Number",
                    "string": "String",
                    "boolean": "Boolean"
                };
                const pxtString = (_a = primativeToQname[tcString]) !== null && _a !== void 0 ? _a : tcString;
                return pxtString;
            }
            service.tsTypeToPxtTypeString = tsTypeToPxtTypeString;
            function filenameWithExtension(filename, extension) {
                if (extension.charAt(0) === ".")
                    extension = extension.substr(1);
                return filename.substr(0, filename.lastIndexOf(".") + 1) + extension;
            }
            service.filenameWithExtension = filenameWithExtension;
            /**
             * This function only cares about getting words of the form [a-zA-z]+
             */
            function getWordAtPosition(text, position) {
                let start = position;
                let end = position;
                while (start > 0 && isWordCharacter(start))
                    --start;
                while (end < text.length - 1 && isWordCharacter(end))
                    ++end;
                if (start != end) {
                    return {
                        text: text.substring(start + 1, end),
                        start: start + 1,
                        end: end
                    };
                }
                return null;
                function isWordCharacter(index) {
                    const charCode = text.charCodeAt(index);
                    return charCode >= 65 && charCode <= 90 || charCode >= 97 && charCode <= 122;
                }
            }
            service.getWordAtPosition = getWordAtPosition;
            function getTsSymbolFromPxtSymbol(pxtSym, location, meaning) {
                const checker = service.service && service.service.getProgram().getTypeChecker();
                if (!checker)
                    return null;
                const tsSymbols = checker.getSymbolsInScope(location, meaning);
                for (let tsSym of tsSymbols) {
                    if (tsSym.escapedName.toString() === pxtSym.qName)
                        return tsSym;
                }
                return null;
            }
            service.getTsSymbolFromPxtSymbol = getTsSymbolFromPxtSymbol;
            function getDefaultEnumValue(t, python) {
                // Note: AFAIK this is NOT guranteed to get the same default as you get in
                // blocks. That being said, it should get the first declared value. Only way
                // to guarantee an API has the same default in blocks and in TS is to actually
                // set a default on the parameter in its comment attributes
                const checker = service.service && service.service.getProgram().getTypeChecker();
                const members = pxtc.getEnumMembers(checker, t);
                for (const member of members) {
                    if (member.name.kind === pxtc.SK.Identifier) {
                        const fullName = pxtc.enumMemberToQName(checker, member);
                        const pxtSym = service.lastApiInfo.apis.byQName[fullName];
                        if (pxtSym) {
                            if (pxtSym.attributes.alias)
                                // use pyAlias if python; or default to alias
                                return (python && pxtSym.attributes.pyAlias) || pxtSym.attributes.alias; // prefer alias
                            return python ? pxtSym.pyQName : pxtSym.qName;
                        }
                        else
                            return fullName;
                    }
                }
                return "0";
            }
            service.getDefaultEnumValue = getDefaultEnumValue;
            function getCompletions(v) {
                var _a, _b;
                const { fileName, fileContent, position, wordStartPos, wordEndPos, runtime } = v;
                let src = fileContent;
                if (fileContent) {
                    service.host.setFile(fileName, fileContent);
                }
                const tsFilename = filenameWithExtension(fileName, "ts");
                const span = { startPos: wordStartPos, endPos: wordEndPos };
                const isPython = /\.py$/.test(fileName);
                const r = {
                    entries: [],
                    isMemberCompletion: false,
                    isNewIdentifierLocation: true,
                    isTypeLocation: false,
                    namespace: [],
                };
                // get line text
                let lastNl = src.lastIndexOf("\n", position - 1);
                lastNl = Math.max(0, lastNl);
                const lineText = src.substring(lastNl + 1, position);
                // are we on a line comment, if so don't show completions
                // NOTE: multi-line comments and string literals are handled
                //  later as they require parsing
                const lineCommentStr = isPython ? "#" : "//";
                if (lineText.trim().startsWith(lineCommentStr)) {
                    return r;
                }
                let dotIdx = -1;
                let complPosition = -1;
                for (let i = position - 1; i >= 0; --i) {
                    if (src[i] == ".") {
                        dotIdx = i;
                        break;
                    }
                    if (!/\w/.test(src[i]))
                        break;
                    if (complPosition == -1)
                        complPosition = i;
                }
                if (dotIdx == position - 1) {
                    // "foo.|" -> we add "_" as field name to minimize the risk of a parse error
                    src = src.slice(0, position) + "_" + src.slice(position);
                }
                else if (complPosition == -1) {
                    src = src.slice(0, position) + "_" + src.slice(position);
                    complPosition = position;
                }
                const isMemberCompletion = dotIdx !== -1;
                r.isMemberCompletion = isMemberCompletion;
                const partialWord = isMemberCompletion ? src.slice(dotIdx + 1, wordEndPos) : src.slice(wordStartPos, wordEndPos);
                const MAX_SYMBOLS_BEFORE_FILTER = 50;
                const MAX_SYMBOLS = 100;
                if (isMemberCompletion)
                    complPosition = dotIdx;
                const entries = {};
                let opts = service.cloneCompileOpts(service.host.opts);
                opts.fileSystem[fileName] = src;
                service.addApiInfo(opts);
                opts.syntaxInfo = {
                    position: complPosition,
                    type: r.isMemberCompletion ? "memberCompletion" : "identifierCompletion"
                };
                let resultSymbols = [];
                let tsPos;
                if (isPython) {
                    // for Python, we need to transpile into TS and map our location into
                    // TS
                    const res = pxtc.transpile.pyToTs(opts);
                    if (res.syntaxInfo && res.syntaxInfo.symbols) {
                        resultSymbols = completionSymbols(res.syntaxInfo.symbols, COMPLETION_DEFAULT_WEIGHT);
                    }
                    if (res.globalNames)
                        service.lastGlobalNames = res.globalNames;
                    if (!resultSymbols.length && res.globalNames) {
                        resultSymbols = completionSymbols(pxt.U.values(res.globalNames), COMPLETION_DEFAULT_WEIGHT);
                    }
                    // update our language host
                    Object.keys(res.outfiles)
                        .forEach(k => {
                        if (k === tsFilename) {
                            service.host.setFile(k, res.outfiles[k]);
                        }
                    });
                    // convert our location from python to typescript
                    if (res.sourceMap) {
                        const pySrc = src;
                        const tsSrc = res.outfiles[tsFilename] || "";
                        const srcMap = pxtc.BuildSourceMapHelpers(res.sourceMap, tsSrc, pySrc);
                        const smallest = srcMap.py.smallestOverlap(span);
                        if (smallest) {
                            tsPos = smallest.ts.startPos;
                        }
                    }
                    // filter based on word match if we get too many (ideally we'd leave this filtering for monaco as it's
                    // better at fuzzy matching and fluidly changing but for performance reasons we want to do it here)
                    if (!isMemberCompletion && resultSymbols.length > MAX_SYMBOLS_BEFORE_FILTER) {
                        resultSymbols = resultSymbols
                            .filter(s => (isPython ? s.symbol.pyQName : s.symbol.qName).toLowerCase().indexOf(partialWord.toLowerCase()) >= 0);
                    }
                    opts.ast = true;
                    const ts2asm = pxtc.compile(opts, service.service);
                }
                else {
                    tsPos = position;
                    opts.ast = true;
                    service.host.setOpts(opts);
                    const res = service.runConversionsAndCompileUsingService();
                }
                const prog = service.service.getProgram();
                const tsAst = prog.getSourceFile(tsFilename);
                const tc = prog.getTypeChecker();
                let tsNode = pxtc.findInnerMostNodeAtPosition(tsAst, tsPos);
                const commentMap = pxtc.decompiler.buildCommentMap(tsAst);
                // abort if we're in a comment
                const inComment = commentMap.some(range => range.start <= position && position <= range.end);
                if (inComment) {
                    return r;
                }
                // abort if we're in a string literal
                if (tsNode) {
                    const stringLiteralKinds = [pxtc.SK.StringLiteral, pxtc.SK.FirstTemplateToken, pxtc.SK.NoSubstitutionTemplateLiteral];
                    const inLiteral = stringLiteralKinds.some(k => tsNode.kind === k);
                    if (inLiteral) {
                        return r;
                    }
                }
                // determine the current namespace
                r.namespace = pxtc.getCurrentNamespaces(tsNode);
                // special handing for member completion
                let didFindMemberCompletions = false;
                if (isMemberCompletion) {
                    const propertyAccessTarget = pxtc.findInnerMostNodeAtPosition(tsAst, isPython ? tsPos : dotIdx - 1);
                    if (propertyAccessTarget) {
                        let type;
                        const symbol = tc.getSymbolAtLocation(propertyAccessTarget);
                        if (((_a = symbol === null || symbol === void 0 ? void 0 : symbol.members) === null || _a === void 0 ? void 0 : _a.size) > 0) {
                            // Some symbols for nodes like "this" are directly the symbol for the type (e.g. "this" gives "Foo" class symbol)
                            type = tc.getDeclaredTypeOfSymbol(symbol);
                        }
                        else if (symbol) {
                            // Otherwise we use the typechecker to lookup the symbol type
                            type = tc.getTypeOfSymbolAtLocation(symbol, propertyAccessTarget);
                        }
                        else {
                            type = tc.getTypeAtLocation(propertyAccessTarget);
                        }
                        if (type) {
                            const qname = type.symbol ? tc.getFullyQualifiedName(type.symbol) : tsTypeToPxtTypeString(type, tc);
                            if (qname) {
                                const props = type.getApparentProperties()
                                    .map(prop => qname + "." + prop.getName())
                                    .map(propQname => service.lastApiInfo.apis.byQName[propQname])
                                    .filter(prop => !!prop)
                                    .map(prop => completionSymbol(prop, COMPLETION_DEFAULT_WEIGHT));
                                resultSymbols = props;
                                didFindMemberCompletions = true;
                            }
                        }
                    }
                }
                const allSymbols = pxt.U.values(service.lastApiInfo.apis.byQName);
                if (resultSymbols.length === 0) {
                    // if by this point we don't yet have a specialized set of results (like those for member completion), use all global api symbols as the start and filter by matching prefix if possible
                    let wordMatching = allSymbols.filter(s => (isPython ? s.pyQName : s.qName).toLowerCase().indexOf(partialWord.toLowerCase()) >= 0);
                    resultSymbols = completionSymbols(wordMatching, COMPLETION_DEFAULT_WEIGHT);
                }
                // gather local variables that won't have pxt symbol info
                if (!isPython && !didFindMemberCompletions) {
                    // TODO: share this with the "syntaxinfo" service
                    // use the typescript service to get symbols in scope
                    tsNode = pxtc.findInnerMostNodeAtPosition(tsAst, wordStartPos);
                    if (!tsNode)
                        tsNode = tsAst.getSourceFile();
                    let symSearch = ts_1.SymbolFlags.Variable;
                    let inScopeTsSyms = tc.getSymbolsInScope(tsNode, symSearch);
                    // filter these to just what's at the cursor, otherwise we get things
                    //  like JS Array methods we don't support
                    let matchStr = tsNode.getText();
                    if (matchStr !== "_") // if have a real identifier ("_" is a placeholder we added), filter to prefix matches
                        inScopeTsSyms = inScopeTsSyms.filter(s => s.name.indexOf(matchStr) >= 0);
                    // convert these to pxt symbols
                    let inScopePxtSyms = inScopeTsSyms
                        .map(t => {
                        let pxtSym = getPxtSymbolFromTsSymbol(t, service.lastApiInfo.apis, tc);
                        if (!pxtSym) {
                            let tsType = tc.getTypeOfSymbolAtLocation(t, tsNode);
                            pxtSym = makePxtSymbolFromTsSymbol(t, tsType);
                        }
                        return pxtSym;
                    })
                        .filter(s => !!s)
                        .map(s => completionSymbol(s, COMPLETION_DEFAULT_WEIGHT));
                    // in scope locals should be weighter higher
                    inScopePxtSyms.forEach(s => s.weight += COMPLETION_IN_SCOPE_VAR_WEIGHT);
                    resultSymbols = [...resultSymbols, ...inScopePxtSyms];
                }
                // special handling for call expressions
                const call = pxtc.getParentCallExpression(tsNode);
                if (call) {
                    // which argument are we ?
                    let paramIdx = pxtc.findCurrentCallArgIdx(call, tsNode, tsPos);
                    // if we're not one of the arguments, are we at the
                    // determine parameter idx
                    if (paramIdx >= 0) {
                        const blocksInfo = service.blocksInfoOp(service.lastApiInfo.apis, runtime.bannedCategories);
                        const callSym = getCallSymbol(call);
                        if (callSym) {
                            if (paramIdx >= callSym.parameters.length)
                                paramIdx = callSym.parameters.length - 1;
                            const param = getParameter(callSym, paramIdx, blocksInfo); // shakao get param type
                            if (param) {
                                // weight the results higher if they return the correct type for the parameter
                                const matchingApis = getApisForTsType(param.type, call, tc, resultSymbols, param.isEnum);
                                matchingApis.forEach(match => match.weight = COMPLETION_MATCHING_PARAM_TYPE_WEIGHT);
                            }
                        }
                    }
                }
                // add in keywords
                if (!isMemberCompletion) {
                    // TODO: use more context to filter keywords
                    //      e.g. "while" shouldn't show up in an expression
                    let keywords;
                    if (isPython) {
                        let keywordsMap = pxt.py.keywords;
                        keywords = Object.keys(keywordsMap);
                    }
                    else {
                        keywords = [...ts.pxtc.reservedWords, ...ts.pxtc.keywordTypes];
                    }
                    let keywordSymbols = keywords
                        .filter(k => k.indexOf(partialWord) >= 0)
                        .map(makePxtSymbolFromKeyword)
                        .map(s => completionSymbol(s, COMPLETION_KEYWORD_WEIGHT));
                    resultSymbols = [...resultSymbols, ...keywordSymbols];
                }
                // determine which names are taken for auto-generated variable names
                let takenNames = {};
                if (isPython && service.lastGlobalNames) {
                    takenNames = service.lastGlobalNames;
                }
                else {
                    takenNames = service.lastApiInfo.apis.byQName;
                }
                // swap aliases, filter symbols
                resultSymbols
                    .map(sym => {
                    // skip for enum member completions (eg "AnimalMob."" should have "Chicken", not "CHICKEN")
                    if (sym.symbol.attributes.alias && !(isMemberCompletion && sym.symbol.kind === 7 /* EnumMember */)) {
                        return completionSymbol(service.lastApiInfo.apis.byQName[sym.symbol.attributes.alias], sym.weight);
                    }
                    else {
                        return sym;
                    }
                })
                    .filter(shouldUseSymbol)
                    .forEach(sym => {
                    entries[sym.symbol.qName] = sym;
                });
                resultSymbols = pxt.Util.values(entries)
                    .filter(a => !!a && !!a.symbol);
                // sort entries
                resultSymbols.sort(compareCompletionSymbols);
                // limit the number of entries
                if (v.light && resultSymbols.length > MAX_SYMBOLS) {
                    resultSymbols = resultSymbols.splice(0, MAX_SYMBOLS);
                }
                // add in snippets if not present already
                const { bannedCategories, screenSize } = v.runtime;
                const blocksInfo = service.blocksInfoOp(service.lastApiInfo.apis, bannedCategories);
                const context = {
                    takenNames,
                    blocksInfo,
                    screenSize,
                    apis: service.lastApiInfo.apis,
                    checker: (_b = service.service === null || service.service === void 0 ? void 0 : service.service.getProgram()) === null || _b === void 0 ? void 0 : _b.getTypeChecker()
                };
                resultSymbols.forEach(sym => patchSymbolWithSnippet(sym.symbol, isPython, context));
                r.entries = resultSymbols.map(sym => sym.symbol);
                return r;
            }
            service.getCompletions = getCompletions;
            function shouldUseSymbol({ symbol: si }) {
                let use = !(/^__/.test(si.name) || // ignore members starting with __
                    /^__/.test(si.namespace) || // ignore namespaces starting with __
                    si.attributes.hidden ||
                    si.attributes.deprecated ||
                    // ignore TD_ID helpers
                    si.attributes.shim == "TD_ID" ||
                    // ignore block aliases like "_popStatement" on arrays
                    si.attributes.blockAliasFor);
                return use;
            }
            function patchSymbolWithSnippet(si, isPython, context) {
                const n = service.lastApiInfo.decls[si.qName];
                if (ts_1.isFunctionLike(n)) {
                    // snippet/pySnippet might have been set already, but even if it has,
                    // we always want to recompute it if the snippet introduces new definitions
                    // because we need to ensure name uniqueness
                    if (si.snippetAddsDefinitions
                        || (isPython && !si.pySnippet)
                        || (!isPython && !si.snippet)) {
                        const snippetNode = service.getSnippet(context, si, n, isPython);
                        const snippet = service.snippetStringify(snippetNode);
                        const snippetWithMarkers = service.snippetStringify(snippetNode, true);
                        const addsDefinitions = service.snippetAddsDefinitions(snippetNode);
                        if (isPython) {
                            si.pySnippet = snippet;
                            si.pySnippetWithMarkers = snippetWithMarkers;
                        }
                        else {
                            si.snippet = snippet;
                            si.snippetWithMarkers = snippetWithMarkers;
                        }
                        si.snippetAddsDefinitions = addsDefinitions;
                    }
                }
            }
        })(service = pxtc.service || (pxtc.service = {}));
    })(pxtc = ts_1.pxtc || (ts_1.pxtc = {}));
})(ts || (ts = {}));
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        let reportDiagnostic = reportDiagnosticSimply;
        function reportDiagnostics(diagnostics) {
            for (const diagnostic of diagnostics) {
                reportDiagnostic(diagnostic);
            }
        }
        function reportDiagnosticSimply(diagnostic) {
            let output = getDiagnosticString(diagnostic);
            ts.sys.write(output);
        }
        function getDiagnosticString(diagnostic) {
            let ksDiagnostic;
            if (isTsDiagnostic(diagnostic)) {
                // convert ts.Diagnostic to KsDiagnostic
                let tsDiag = diagnostic;
                const { line, character } = ts.getLineAndCharacterOfPosition(tsDiag.file, tsDiag.start);
                const relativeFileName = tsDiag.file.fileName;
                ksDiagnostic = Object.assign({
                    fileName: relativeFileName,
                    line: line,
                    column: character
                }, tsDiag);
            }
            else {
                ksDiagnostic = Object.assign({
                    fileName: undefined,
                    line: undefined,
                    column: undefined
                }, diagnostic);
            }
            return getDiagnosticStringHelper(ksDiagnostic);
        }
        pxtc.getDiagnosticString = getDiagnosticString;
        function getDiagnosticStringHelper(diagnostic) {
            let output = "";
            if (diagnostic.fileName) {
                output += `${diagnostic.fileName}(${diagnostic.line + 1},${diagnostic.column + 1}): `;
            }
            let nl = ts.sys ? ts.sys.newLine : "\n";
            const category = pxtc.DiagnosticCategory[diagnostic.category].toLowerCase();
            output += `${category} TS${diagnostic.code}: ${pxtc.flattenDiagnosticMessageText(diagnostic.messageText, nl)}${nl}`;
            return output;
        }
        function isTsDiagnostic(a) {
            return a.file !== undefined;
        }
        function plainTscCompileDir(dir) {
            const commandLine = ts.parseCommandLine([]);
            let configFileName = ts.findConfigFile(dir, ts.sys.fileExists);
            const configParseResult = parseConfigFile();
            let program = plainTscCompileFiles(configParseResult.fileNames, configParseResult.options);
            let diagnostics = getProgramDiagnostics(program);
            diagnostics.forEach(reportDiagnostic);
            return program;
            function parseConfigFile() {
                let cachedConfigFileText = ts.sys.readFile(configFileName);
                const result = ts.parseConfigFileTextToJson(configFileName, cachedConfigFileText);
                const configObject = result.config;
                if (!configObject) {
                    reportDiagnostics([result.error]);
                    ts.sys.exit(ts.ExitStatus.DiagnosticsPresent_OutputsSkipped);
                    return undefined;
                }
                const configParseResult = ts.parseJsonConfigFileContent(configObject, ts.sys, dir, commandLine.options, configFileName);
                if (configParseResult.errors.length > 0) {
                    reportDiagnostics(configParseResult.errors);
                    ts.sys.exit(ts.ExitStatus.DiagnosticsPresent_OutputsSkipped);
                    return undefined;
                }
                return configParseResult;
            }
        }
        pxtc.plainTscCompileDir = plainTscCompileDir;
        function plainTscCompileFiles(fileNames, compilerOpts) {
            const compilerHost = ts.createCompilerHost(compilerOpts);
            compilerHost.getDefaultLibFileName = () => "node_modules/pxt-core/pxtcompiler/ext-typescript/lib/lib.d.ts";
            let prog = ts.createProgram(fileNames, compilerOpts, compilerHost);
            return prog;
            //const emitOutput = program.emit();
            //diagnostics = diagnostics.concat(emitOutput.diagnostics);
        }
        pxtc.plainTscCompileFiles = plainTscCompileFiles;
        function getProgramDiagnostics(program) {
            let diagnostics = program.getSyntacticDiagnostics();
            if (diagnostics.length === 0) {
                diagnostics = program.getOptionsDiagnostics().concat(pxtc.Util.toArray(program.getGlobalDiagnostics()));
                if (diagnostics.length === 0) {
                    diagnostics = program.getSemanticDiagnostics();
                }
            }
            return diagnostics.slice(0); // fix TS 3.5 vs 2.x issue
        }
        pxtc.getProgramDiagnostics = getProgramDiagnostics;
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
// TODO: enable reference so we don't need to use: (pxt as any).py
//      the issue is that this creates a circular dependency. This
//      is easily handled if we used proper TS modules.
//// <reference path="../../built/pxtpy.d.ts"/>
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        pxtc.placeholderChar = "◊";
        pxtc.ts2PyFunNameMap = {
            "Math.trunc": { n: "int", t: ts.SyntaxKind.NumberKeyword, snippet: "int(0)" },
            "Math.min": { n: "min", t: ts.SyntaxKind.NumberKeyword, snippet: "min(0, 0)" },
            "Math.max": { n: "max", t: ts.SyntaxKind.NumberKeyword, snippet: "max(0, 0)" },
            "Math.abs": { n: "abs", t: ts.SyntaxKind.NumberKeyword, snippet: "abs(0)" },
            "console.log": { n: "print", t: ts.SyntaxKind.VoidKeyword, snippet: 'print(":)")' },
            ".length": { n: "len", t: ts.SyntaxKind.NumberKeyword },
            ".toLowerCase()": { n: "string.lower", t: ts.SyntaxKind.StringKeyword },
            ".toUpperCase()": { n: "string.upper", t: ts.SyntaxKind.StringKeyword },
            ".charCodeAt(0)": { n: "ord", t: ts.SyntaxKind.NumberKeyword },
            "pins.createBuffer": { n: "bytearray", t: ts.SyntaxKind.Unknown },
            "pins.createBufferFromArray": { n: "bytes", t: ts.SyntaxKind.Unknown },
            "control.createBuffer": { n: "bytearray", t: ts.SyntaxKind.Unknown },
            "control.createBufferFromArray": { n: "bytes", t: ts.SyntaxKind.Unknown },
            "!!": { n: "bool", t: ts.SyntaxKind.BooleanKeyword },
            "Array.indexOf": { n: "Array.index", t: ts.SyntaxKind.Unknown },
            "Array.push": { n: "Array.append", t: ts.SyntaxKind.Unknown },
            "parseInt": { n: "int", t: ts.SyntaxKind.NumberKeyword, snippet: 'int("0")' },
            "_py.range": { n: "range", t: ts.SyntaxKind.Unknown, snippet: 'range(4)' }
        };
        function emitPyTypeFromTypeNode(s) {
            if (!s || !s.kind)
                return null;
            switch (s.kind) {
                case ts.SyntaxKind.StringKeyword:
                    return "str";
                case ts.SyntaxKind.NumberKeyword:
                    // Note, "real" python expects this to be "float" or "int", we're intentionally diverging here
                    return "number";
                case ts.SyntaxKind.BooleanKeyword:
                    return "bool";
                case ts.SyntaxKind.VoidKeyword:
                    return "None";
                case ts.SyntaxKind.FunctionType:
                    return emitFuncPyType(s);
                case ts.SyntaxKind.ArrayType: {
                    let t = s;
                    let elType = emitPyTypeFromTypeNode(t.elementType);
                    return `List[${elType}]`;
                }
                case ts.SyntaxKind.TypeReference: {
                    let t = s;
                    let nm = t.typeName && t.typeName.getText ? t.typeName.getText() : "";
                    return nm;
                }
                case ts.SyntaxKind.AnyKeyword:
                    return "any";
                default:
                    pxt.tickEvent("depython.todo.tstypenodetopytype", { kind: s.kind });
                    return ``;
            }
            // // TODO translate type
            // return s.getText()
        }
        pxtc.emitPyTypeFromTypeNode = emitPyTypeFromTypeNode;
        function emitPyTypeFromTsType(s) {
            if (!s || !s.flags)
                return null;
            switch (s.flags) {
                case ts.TypeFlags.String:
                    return "str";
                case ts.TypeFlags.Number:
                    // Note: "real" python expects this to be "float" or "int", we're intentionally diverging here
                    return "number";
                case ts.TypeFlags.Boolean:
                    return "bool";
                case ts.TypeFlags.Void:
                    return "None";
                case ts.TypeFlags.Any:
                    return "any";
                default:
                    pxt.tickEvent("depython.todo.tstypetopytype", { kind: s.flags });
                    return ``;
            }
        }
        pxtc.emitPyTypeFromTsType = emitPyTypeFromTsType;
        function emitFuncPyType(s) {
            let returnType = emitPyTypeFromTypeNode(s.type);
            let params = s.parameters
                .map(p => p.type) // python type syntax doesn't allow names
                .map(emitPyTypeFromTypeNode);
            // "Real" python expects this to be "Callable[[arg1, arg2], ret]", we're intentionally changing to "(arg1, arg2) -> ret"
            return `(${params.join(", ")}) -> ${returnType}`;
        }
        function getSymbolKind(node) {
            switch (node.kind) {
                case pxtc.SK.MethodDeclaration:
                case pxtc.SK.MethodSignature:
                    return 1 /* Method */;
                case pxtc.SK.PropertyDeclaration:
                case pxtc.SK.PropertySignature:
                case pxtc.SK.GetAccessor:
                case pxtc.SK.SetAccessor:
                    return 2 /* Property */;
                case pxtc.SK.Constructor:
                case pxtc.SK.FunctionDeclaration:
                    return 3 /* Function */;
                case pxtc.SK.VariableDeclaration:
                    return 4 /* Variable */;
                case pxtc.SK.ModuleDeclaration:
                    return 5 /* Module */;
                case pxtc.SK.EnumDeclaration:
                    return 6 /* Enum */;
                case pxtc.SK.EnumMember:
                    return 7 /* EnumMember */;
                case pxtc.SK.ClassDeclaration:
                    return 8 /* Class */;
                case pxtc.SK.InterfaceDeclaration:
                    return 9 /* Interface */;
                default:
                    return 0 /* None */;
            }
        }
        function createSymbolInfo(typechecker, qName, stmt) {
            function typeOf(tn, n, stripParams = false) {
                let t = typechecker.getTypeAtLocation(n);
                if (!t)
                    return "None";
                if (stripParams) {
                    t = t.getCallSignatures()[0].getReturnType();
                }
                const readableName = typechecker.typeToString(t, undefined, ts.TypeFormatFlags.UseFullyQualifiedType);
                // TypeScript 2.0.0+ will assign constant variables numeric literal types which breaks the
                // type checking we do in the blocks
                // This can be a number literal '7' or a union type of them '0 | 1 | 2'
                if (/^\d/.test(readableName)) {
                    return "number";
                }
                if (readableName == "this") {
                    return getFullName(typechecker, t.symbol);
                }
                return readableName;
            }
            let kind = getSymbolKind(stmt);
            if (kind != 0 /* None */) {
                let decl = stmt;
                let attributes = pxtc.parseComments(decl);
                if (attributes.weight < 0)
                    return null;
                let m = /^(.*)\.(.*)/.exec(qName);
                let hasParams = kind == 3 /* Function */ || kind == 1 /* Method */;
                let pkg = null;
                let pkgs = null;
                let src = ts.getSourceFileOfNode(stmt);
                if (src) {
                    let m = /^pxt_modules\/([^\/]+)/.exec(src.fileName);
                    if (m)
                        pkg = m[1];
                }
                let extendsTypes = undefined;
                if (kind == 8 /* Class */ || kind == 9 /* Interface */) {
                    let cl = stmt;
                    extendsTypes = [];
                    if (cl.heritageClauses)
                        for (let h of cl.heritageClauses) {
                            if (h.types) {
                                for (let t of h.types) {
                                    extendsTypes.push(typeOf(t, t));
                                }
                            }
                        }
                }
                if (kind == 6 /* Enum */ || kind === 7 /* EnumMember */) {
                    (extendsTypes || (extendsTypes = [])).push("Number");
                }
                let r = {
                    kind,
                    qName,
                    namespace: m ? m[1] : "",
                    name: m ? m[2] : qName,
                    fileName: stmt.getSourceFile().fileName,
                    attributes,
                    pkg,
                    pkgs,
                    extendsTypes,
                    retType: stmt.kind == ts.SyntaxKind.Constructor ? "void" :
                        kind == 5 /* Module */ ? "" :
                            typeOf(decl.type, decl, hasParams),
                    parameters: !hasParams ? null : pxtc.Util.toArray(decl.parameters).map((p, i) => {
                        let n = pxtc.getName(p);
                        let desc = attributes.paramHelp[n] || "";
                        let minVal = attributes.paramMin && attributes.paramMin[n];
                        let maxVal = attributes.paramMax && attributes.paramMax[n];
                        let m = /\beg\.?:\s*(.+)/.exec(desc);
                        let props;
                        let parameters;
                        if (p.type && p.type.kind === pxtc.SK.FunctionType) {
                            const callBackSignature = typechecker.getSignatureFromDeclaration(p.type);
                            const callbackParameters = callBackSignature.getParameters();
                            if (attributes.mutate === "objectdestructuring") {
                                pxtc.assert(callbackParameters.length > 0);
                                props = typechecker.getTypeAtLocation(callbackParameters[0].valueDeclaration).getProperties().map(prop => {
                                    return { name: prop.getName(), type: typechecker.typeToString(typechecker.getTypeOfSymbolAtLocation(prop, callbackParameters[0].valueDeclaration)) };
                                });
                            }
                            else {
                                parameters = callbackParameters.map((sym, i) => {
                                    return {
                                        name: sym.getName(),
                                        type: typechecker.typeToString(typechecker.getTypeOfSymbolAtLocation(sym, p), undefined, ts.TypeFormatFlags.UseFullyQualifiedType)
                                    };
                                });
                            }
                        }
                        let options = {};
                        const paramType = typechecker.getTypeAtLocation(p);
                        let isEnum = paramType && !!(paramType.flags & (ts.TypeFlags.Enum | ts.TypeFlags.EnumLiteral));
                        if (attributes.block && attributes.paramShadowOptions) {
                            const argNames = [];
                            attributes.block.replace(/%(\w+)/g, (f, n) => {
                                argNames.push(n);
                                return "";
                            });
                            if (attributes.paramShadowOptions[argNames[i]]) {
                                options['fieldEditorOptions'] = { value: attributes.paramShadowOptions[argNames[i]] };
                            }
                        }
                        if (minVal)
                            options['min'] = { value: minVal };
                        if (maxVal)
                            options['max'] = { value: maxVal };
                        const pyTypeString = (p.type && emitPyTypeFromTypeNode(p.type))
                            || (paramType && emitPyTypeFromTsType(paramType))
                            || "unknown";
                        const initializer = p.initializer ? p.initializer.getText() :
                            pxtc.getExplicitDefault(attributes, n) ||
                                (p.questionToken ? "undefined" : undefined);
                        return {
                            name: n,
                            description: desc,
                            type: typeOf(p.type, p),
                            pyTypeString,
                            initializer,
                            default: attributes.paramDefl[n],
                            properties: props,
                            handlerParameters: parameters,
                            options: options,
                            isEnum
                        };
                    }),
                    snippet: ts.isFunctionLike(stmt) ? null : undefined
                };
                switch (r.kind) {
                    case 7 /* EnumMember */:
                        r.pyName = pxtc.U.snakify(r.name).toUpperCase();
                        break;
                    case 4 /* Variable */:
                    case 1 /* Method */:
                    case 2 /* Property */:
                    case 3 /* Function */:
                        r.pyName = pxtc.U.snakify(r.name);
                        break;
                    case 6 /* Enum */:
                    case 8 /* Class */:
                    case 9 /* Interface */:
                    case 5 /* Module */:
                    default:
                        r.pyName = r.name;
                        break;
                }
                if (stmt.kind === pxtc.SK.GetAccessor ||
                    ((stmt.kind === pxtc.SK.PropertyDeclaration || stmt.kind === pxtc.SK.PropertySignature) && pxtc.isReadonly(stmt))) {
                    r.isReadOnly = true;
                }
                return r;
            }
            return null;
        }
        function genDocs(pkg, apiInfo, options = {}) {
            pxt.debug(`generating docs for ${pkg}`);
            pxt.debug(JSON.stringify(Object.keys(apiInfo.byQName), null, 2));
            const files = {};
            const infos = pxtc.Util.values(apiInfo.byQName);
            const enumMembers = infos.filter(si => si.kind == 7 /* EnumMember */)
                .sort(compareSymbols);
            const snippetStrings = {};
            const locStrings = {};
            const jsdocStrings = {};
            const writeLoc = (si) => {
                if (!options.locs || !si.qName) {
                    return;
                }
                if (/^__/.test(si.name))
                    return; // skip functions starting with __
                pxt.debug(`loc: ${si.qName}`);
                // must match blockly loader
                if (si.kind != 7 /* EnumMember */) {
                    const ns = ts.pxtc.blocksCategory(si);
                    if (ns)
                        locStrings[`{id:category}${ns}`] = ns;
                }
                if (si.attributes.jsDoc)
                    jsdocStrings[si.qName] = si.attributes.jsDoc;
                if (si.attributes.block)
                    locStrings[`${si.qName}|block`] = si.attributes.block;
                if (si.attributes.group)
                    locStrings[`{id:group}${si.attributes.group}`] = si.attributes.group;
                if (si.attributes.subcategory)
                    locStrings[`{id:subcategory}${si.attributes.subcategory}`] = si.attributes.subcategory;
                if (si.parameters)
                    si.parameters.filter(pi => !!pi.description).forEach(pi => {
                        jsdocStrings[`${si.qName}|param|${pi.name}`] = pi.description;
                    });
            };
            const mapLocs = (m, name) => {
                if (!options.locs)
                    return;
                const locs = {};
                Object.keys(m).sort().forEach(l => locs[l] = m[l]);
                files[pkg + name + "-strings.json"] = JSON.stringify(locs, null, 2);
            };
            for (const info of infos) {
                const isNamespace = info.kind == 5 /* Module */;
                if (isNamespace) {
                    if (!infos.filter(si => si.namespace == info.name && !!si.attributes.jsDoc)[0])
                        continue; // nothing in namespace
                    if (!info.attributes.block)
                        info.attributes.block = info.name; // reusing this field to store localized namespace name
                }
                writeLoc(info);
            }
            if (options.locs)
                enumMembers.forEach(em => {
                    if (em.attributes.block)
                        locStrings[`${em.qName}|block`] = em.attributes.block;
                    if (em.attributes.jsDoc)
                        locStrings[em.qName] = em.attributes.jsDoc;
                });
            mapLocs(locStrings, "");
            mapLocs(jsdocStrings, "-jsdoc");
            // Localize pxtsnippets.json files
            if (options.pxtsnippet) {
                options.pxtsnippet.forEach(snippet => localizeSnippet(snippet, snippetStrings));
                mapLocs(snippetStrings, "-snippet");
            }
            return files;
        }
        pxtc.genDocs = genDocs;
        function localizeSnippet(snippet, locs) {
            const localizableQuestionProperties = ['label', 'title', 'hint', 'errorMessage']; // TODO(jb) provide this elsewhere
            locs[snippet.label] = snippet.label;
            snippet.questions.forEach((question) => {
                localizableQuestionProperties.forEach((prop) => {
                    if (question[prop]) {
                        locs[question[prop]] = question[prop];
                    }
                });
            });
        }
        function hasBlock(sym) {
            return !!sym.attributes.block && !!sym.attributes.blockId;
        }
        pxtc.hasBlock = hasBlock;
        let symbolKindWeight;
        function compareSymbols(l, r) {
            function cmpr(toValue) {
                const c = -toValue(l) + toValue(r);
                return c;
            }
            // favor symbols with blocks
            let c = cmpr(s => hasBlock(s) ? 1 : -1);
            if (c)
                return c;
            // favor top-level symbols
            c = cmpr(s => !s.namespace ? 1 : -1);
            if (c)
                return c;
            // sort by symbol kind
            if (!symbolKindWeight) {
                symbolKindWeight = {};
                symbolKindWeight[4 /* Variable */] = 100;
                symbolKindWeight[5 /* Module */] = 101;
                symbolKindWeight[3 /* Function */] = 99;
                symbolKindWeight[2 /* Property */] = 98;
                symbolKindWeight[1 /* Method */] = 97;
                symbolKindWeight[8 /* Class */] = 89;
                symbolKindWeight[6 /* Enum */] = 81;
                symbolKindWeight[7 /* EnumMember */] = 80;
            }
            c = cmpr(s => symbolKindWeight[s.kind] || 0);
            if (c)
                return c;
            // check for a weight attribute
            c = cmpr(s => s.attributes.weight || 50);
            if (c)
                return c;
            return pxtc.U.strcmp(l.name, r.name);
        }
        pxtc.compareSymbols = compareSymbols;
        function getApiInfo(program, jres, legacyOnly = false) {
            return internalGetApiInfo(program, jres, legacyOnly).apis;
        }
        pxtc.getApiInfo = getApiInfo;
        function internalGetApiInfo(program, jres, legacyOnly = false) {
            const res = {
                byQName: {},
                jres: jres
            };
            const qNameToNode = {};
            const typechecker = program.getTypeChecker();
            const collectDecls = (stmt) => {
                var _a, _b;
                if (stmt.kind == pxtc.SK.VariableStatement) {
                    let vs = stmt;
                    vs.declarationList.declarations.forEach(collectDecls);
                    return;
                }
                if (pxtc.isExported(stmt)) {
                    if (!stmt.symbol) {
                        console.warn("no symbol", stmt);
                        return;
                    }
                    let qName = getFullName(typechecker, stmt.symbol);
                    if (stmt.kind == pxtc.SK.SetAccessor)
                        qName += "@set"; // otherwise we get a clash with the getter
                    qNameToNode[qName] = stmt;
                    let si = createSymbolInfo(typechecker, qName, stmt);
                    if (si) {
                        let existing = pxtc.U.lookup(res.byQName, qName);
                        if (existing) {
                            // we can have a function and an interface of the same name
                            if (existing.kind == 9 /* Interface */ && si.kind != 9 /* Interface */) {
                                // save existing entry
                                res.byQName[qName + "@type"] = existing;
                            }
                            else if (existing.kind != 9 /* Interface */ && si.kind == 9 /* Interface */) {
                                res.byQName[qName + "@type"] = si;
                                si = existing;
                            }
                            else {
                                const foundSrc = (_a = existing.attributes._source) === null || _a === void 0 ? void 0 : _a.trim();
                                const newSrc = (_b = si.attributes._source) === null || _b === void 0 ? void 0 : _b.trim();
                                let source = foundSrc + "\n" + newSrc;
                                // Avoid duplicating source if possible
                                if (!!foundSrc && (newSrc === null || newSrc === void 0 ? void 0 : newSrc.indexOf(foundSrc)) >= 0) {
                                    source = newSrc;
                                }
                                else if (!!newSrc && (foundSrc === null || foundSrc === void 0 ? void 0 : foundSrc.indexOf(newSrc)) >= 0) {
                                    source = foundSrc;
                                }
                                si.attributes = pxtc.parseCommentString(source);
                                // Check if the colliding symbols are namespace definitions. The same namespace can be
                                // defined in different packages/extensions, so we want to keep track of that information.
                                // That way, we can make sure each cached extension has a copy of the namespace
                                if (existing.kind === 5 /* Module */) {
                                    // Reference the existing array of packages where this namespace has been defined
                                    si.pkgs = existing.pkgs || [];
                                    if (existing.pkg !== si.pkg) {
                                        if (!si.pkgs.find(element => element === existing.pkg)) {
                                            si.pkgs.push(existing.pkg);
                                        }
                                    }
                                }
                                if (existing.extendsTypes) {
                                    si.extendsTypes = si.extendsTypes || [];
                                    existing.extendsTypes.forEach(t => {
                                        if (si.extendsTypes.indexOf(t) === -1) {
                                            si.extendsTypes.push(t);
                                        }
                                    });
                                }
                            }
                        }
                        if (stmt.parent &&
                            (stmt.parent.kind == pxtc.SK.ClassDeclaration || stmt.parent.kind == pxtc.SK.InterfaceDeclaration) &&
                            !pxtc.isStatic(stmt))
                            si.isInstance = true;
                        res.byQName[qName] = si;
                    }
                }
                if (stmt.kind == pxtc.SK.ModuleDeclaration) {
                    let mod = stmt;
                    if (mod.body.kind == pxtc.SK.ModuleBlock) {
                        let blk = mod.body;
                        blk.statements.forEach(collectDecls);
                    }
                    else if (mod.body.kind == pxtc.SK.ModuleDeclaration) {
                        collectDecls(mod.body);
                    }
                }
                else if (stmt.kind == pxtc.SK.InterfaceDeclaration) {
                    let iface = stmt;
                    iface.members.forEach(collectDecls);
                }
                else if (stmt.kind == pxtc.SK.ClassDeclaration) {
                    let iface = stmt;
                    iface.members.forEach(collectDecls);
                }
                else if (stmt.kind == pxtc.SK.EnumDeclaration) {
                    let e = stmt;
                    e.members.forEach(collectDecls);
                }
            };
            for (let srcFile of program.getSourceFiles()) {
                srcFile.statements.forEach(collectDecls);
            }
            let toclose = [];
            // store qName in symbols
            for (let qName in res.byQName) {
                let si = res.byQName[qName];
                si.qName = qName;
                si.attributes._source = null;
                if (si.extendsTypes && si.extendsTypes.length)
                    toclose.push(si);
                let jrname = si.attributes.jres;
                if (jrname) {
                    if (jrname == "true")
                        jrname = qName;
                    let jr = pxtc.U.lookup(jres || {}, jrname);
                    if (jr && jr.icon && !si.attributes.iconURL) {
                        si.attributes.iconURL = jr.icon;
                    }
                    if (jr && jr.data && !si.attributes.jresURL) {
                        si.attributes.jresURL = "data:" + jr.mimeType + ";base64," + jr.data;
                    }
                }
                if (si.pyName) {
                    let override = pxtc.U.lookup(pxtc.ts2PyFunNameMap, si.qName);
                    if (override && override.n) {
                        si.pyQName = override.n;
                        si.pySnippet = override.snippet;
                        si.pySnippetName = override.n;
                        si.pySnippetWithMarkers = undefined;
                    }
                    else if (si.namespace) {
                        let par = res.byQName[si.namespace];
                        if (par) {
                            si.pyQName = par.pyQName + "." + si.pyName;
                        }
                        else {
                            // shouldn't happen
                            pxt.log("namespace missing: " + si.namespace);
                            si.pyQName = si.namespace + "." + si.pyName;
                        }
                    }
                    else {
                        si.pyQName = si.pyName;
                    }
                }
            }
            // transitive closure of inheritance
            let closed = {};
            let closeSi = (si) => {
                if (pxtc.U.lookup(closed, si.qName))
                    return;
                closed[si.qName] = true;
                let mine = {};
                mine[si.qName] = true;
                for (let e of si.extendsTypes || []) {
                    mine[e] = true;
                    let psi = res.byQName[e];
                    if (psi) {
                        closeSi(psi);
                        for (let ee of psi.extendsTypes)
                            mine[ee] = true;
                    }
                }
                si.extendsTypes = Object.keys(mine);
            };
            toclose.forEach(closeSi);
            if (legacyOnly) {
                // conflicts with pins.map()
                delete res.byQName["Array.map"];
            }
            return {
                apis: res,
                decls: qNameToNode
            };
        }
        pxtc.internalGetApiInfo = internalGetApiInfo;
        function getFullName(typechecker, symbol) {
            if (symbol.isBogusSymbol)
                return symbol.name;
            return typechecker.getFullyQualifiedName(symbol);
        }
        pxtc.getFullName = getFullName;
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
(function (ts) {
    var pxtc;
    (function (pxtc) {
        var service;
        (function (service_1) {
            let emptyOptions = {
                fileSystem: {},
                sourceFiles: [],
                target: { isNative: false, hasHex: false, switches: {} }
            };
            class Host {
                constructor() {
                    this.opts = emptyOptions;
                    this.fileVersions = {};
                    this.projectVer = 0;
                    this.pxtModulesOK = null;
                    // resolveModuleNames?(moduleNames: string[], containingFile: string): ResolvedModule[];
                    // directoryExists?(directoryName: string): boolean;
                }
                getProjectVersion() {
                    return this.projectVer + "";
                }
                setFile(fn, cont) {
                    if (this.opts.fileSystem[fn] != cont) {
                        this.fileVersions[fn] = (this.fileVersions[fn] || 0) + 1;
                        this.opts.fileSystem[fn] = cont;
                        this.projectVer++;
                    }
                }
                reset() {
                    this.setOpts(emptyOptions);
                    this.pxtModulesOK = null;
                }
                setOpts(o) {
                    pxtc.Util.iterMap(o.fileSystem, (fn, v) => {
                        if (this.opts.fileSystem[fn] != v) {
                            this.fileVersions[fn] = (this.fileVersions[fn] || 0) + 1;
                        }
                    });
                    // shallow copy, but deep copy the file system
                    this.opts = Object.assign(Object.assign({}, o), { fileSystem: Object.assign({}, o.fileSystem) });
                    this.projectVer++;
                }
                getCompilationSettings() {
                    return pxtc.getTsCompilerOptions(this.opts);
                }
                getScriptFileNames() {
                    return this.opts.sourceFiles.filter(f => pxtc.U.endsWith(f, ".ts"));
                }
                getScriptVersion(fileName) {
                    return (this.fileVersions[fileName] || 0).toString();
                }
                getScriptSnapshot(fileName) {
                    let f = this.opts.fileSystem[fileName];
                    if (f != null)
                        return ts.ScriptSnapshot.fromString(f);
                    else
                        return null;
                }
                getNewLine() { return "\n"; }
                getCurrentDirectory() { return "."; }
                getDefaultLibFileName(options) { return "no-default-lib.d.ts"; }
                log(s) { console.log("LOG", s); }
                trace(s) { console.log("TRACE", s); }
                error(s) { console.error("ERROR", s); }
                useCaseSensitiveFileNames() { return true; }
            }
            // don't export, fuse is internal only
            let lastFuse;
            let lastProjectFuse;
            function fileDiags(fn) {
                if (!/\.ts$/.test(fn))
                    return [];
                let d = service_1.service.getSyntacticDiagnostics(fn);
                if (!d || !d.length)
                    d = service_1.service.getSemanticDiagnostics(fn);
                if (!d)
                    d = [];
                return d;
            }
            function blocksInfoOp(apisInfoLocOverride, bannedCategories) {
                if (apisInfoLocOverride) {
                    if (!service_1.lastLocBlocksInfo) {
                        service_1.lastLocBlocksInfo = pxtc.getBlocksInfo(apisInfoLocOverride, bannedCategories);
                    }
                    return service_1.lastLocBlocksInfo;
                }
                else {
                    if (!service_1.lastBlocksInfo) {
                        service_1.lastBlocksInfo = pxtc.getBlocksInfo(service_1.lastApiInfo.apis, bannedCategories);
                    }
                    return service_1.lastBlocksInfo;
                }
            }
            service_1.blocksInfoOp = blocksInfoOp;
            function getLastApiInfo(opts) {
                if (!service_1.lastApiInfo)
                    service_1.lastApiInfo = pxtc.internalGetApiInfo(service_1.service.getProgram(), opts.jres);
                return service_1.lastApiInfo;
            }
            service_1.getLastApiInfo = getLastApiInfo;
            function addApiInfo(opts) {
                if (!opts.apisInfo) {
                    const info = getLastApiInfo(opts);
                    opts.apisInfo = pxtc.U.clone(info.apis);
                }
            }
            service_1.addApiInfo = addApiInfo;
            function cloneCompileOpts(opts) {
                let newOpts = pxt.U.flatClone(opts);
                newOpts.fileSystem = pxt.U.flatClone(newOpts.fileSystem);
                return newOpts;
            }
            service_1.cloneCompileOpts = cloneCompileOpts;
            ;
            function IsOpErr(res) {
                return !!res.errorMessage;
            }
            service_1.IsOpErr = IsOpErr;
            const operations = {
                reset: () => {
                    service_1.service = ts.createLanguageService(service_1.host);
                    service_1.lastApiInfo = undefined;
                    service_1.lastGlobalNames = undefined;
                    service_1.host.reset();
                },
                setOptions: v => {
                    service_1.host.setOpts(v.options);
                },
                syntaxInfo: v => {
                    var _a, _b, _c;
                    let src = v.fileContent;
                    if (v.fileContent) {
                        service_1.host.setFile(v.fileName, v.fileContent);
                    }
                    let opts = cloneCompileOpts(service_1.host.opts);
                    opts.fileSystem[v.fileName] = src;
                    addApiInfo(opts);
                    opts.syntaxInfo = {
                        position: v.position,
                        type: v.infoType
                    };
                    const isPython = opts.target.preferredEditor == pxt.PYTHON_PROJECT_NAME;
                    const isSymbolReq = opts.syntaxInfo.type === "symbol";
                    const isSignatureReq = opts.syntaxInfo.type === "signature";
                    if (isPython) {
                        let res = pxtc.transpile.pyToTs(opts);
                        if (res.globalNames)
                            service_1.lastGlobalNames = res.globalNames;
                    }
                    else {
                        // typescript
                        opts.ast = true;
                        service_1.host.setOpts(opts);
                        const res = runConversionsAndCompileUsingService();
                        const prog = service_1.service.getProgram();
                        const tsAst = prog.getSourceFile(v.fileName);
                        const tc = prog.getTypeChecker();
                        if (isSymbolReq || isSignatureReq) {
                            let tsNode = pxtc.findInnerMostNodeAtPosition(tsAst, v.position);
                            if (tsNode) {
                                if (isSymbolReq) {
                                    const symbol = tc.getSymbolAtLocation(tsNode);
                                    if (symbol) {
                                        let pxtSym = service_1.getPxtSymbolFromTsSymbol(symbol, opts.apisInfo, tc);
                                        opts.syntaxInfo.symbols = [pxtSym];
                                        opts.syntaxInfo.beginPos = tsNode.getStart();
                                        opts.syntaxInfo.endPos = tsNode.getEnd();
                                    }
                                }
                                else if (isSignatureReq) {
                                    const pxtCall = (_a = tsNode === null || tsNode === void 0 ? void 0 : tsNode.pxt) === null || _a === void 0 ? void 0 : _a.callInfo;
                                    if (pxtCall) {
                                        const pxtSym = opts.apisInfo.byQName[pxtCall.qName];
                                        opts.syntaxInfo.symbols = [pxtSym];
                                        opts.syntaxInfo.beginPos = tsNode.getStart();
                                        opts.syntaxInfo.endPos = tsNode.getEnd();
                                        const tsCall = pxtc.getParentCallExpression(tsNode);
                                        if (tsCall) {
                                            const argIdx = pxtc.findCurrentCallArgIdx(tsCall, tsNode, v.position);
                                            opts.syntaxInfo.auxResult = argIdx;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if (isSymbolReq && !((_b = opts.syntaxInfo.symbols) === null || _b === void 0 ? void 0 : _b.length)) {
                        const possibleKeyword = service_1.getWordAtPosition(v.fileContent, v.position);
                        if (possibleKeyword) {
                            // In python if range() is used in a for-loop, we don't convert
                            // it to a function call when going to TS (we just convert it to
                            // a regular for-loop). Because our symbol detection is based off
                            // of the TS, we won't get a symbol result for range at this position
                            // in the file. This special case makes sure we return the same help
                            // as a standalone call to range().
                            if (isPython && possibleKeyword.text === "range") {
                                const apiInfo = getLastApiInfo(opts).apis;
                                if (apiInfo.byQName["_py.range"]) {
                                    opts.syntaxInfo.symbols = [apiInfo.byQName["_py.range"]];
                                    opts.syntaxInfo.beginPos = possibleKeyword.start;
                                    opts.syntaxInfo.endPos = possibleKeyword.end;
                                }
                            }
                            else {
                                const help = pxtc.getHelpForKeyword(possibleKeyword.text, isPython);
                                if (help) {
                                    opts.syntaxInfo.auxResult = {
                                        documentation: help,
                                        displayString: service_1.displayStringForKeyword(possibleKeyword.text, isPython),
                                    };
                                    opts.syntaxInfo.beginPos = possibleKeyword.start;
                                    opts.syntaxInfo.endPos = possibleKeyword.end;
                                }
                            }
                        }
                    }
                    if ((_c = opts.syntaxInfo.symbols) === null || _c === void 0 ? void 0 : _c.length) {
                        const apiInfo = getLastApiInfo(opts).apis;
                        if (isPython) {
                            opts.syntaxInfo.symbols = opts.syntaxInfo.symbols.map(s => {
                                // symbol info gathered during the py->ts compilation phase
                                // is less precise than the symbol info created when doing
                                // a pass over ts, so we prefer the latter if available
                                return apiInfo.byQName[s.qName] || s;
                            });
                        }
                        if (isSymbolReq) {
                            opts.syntaxInfo.auxResult = opts.syntaxInfo.symbols.map(s => service_1.displayStringForSymbol(s, isPython, apiInfo));
                        }
                    }
                    return opts.syntaxInfo;
                },
                getCompletions: v => {
                    return service_1.getCompletions(v);
                },
                compile: v => {
                    service_1.host.setOpts(v.options);
                    const res = runConversionsAndCompileUsingService();
                    pxtc.timesToMs(res);
                    return res;
                },
                decompile: v => {
                    service_1.host.setOpts(v.options);
                    return pxtc.decompile(service_1.service.getProgram(), v.options, v.fileName, false);
                },
                pydecompile: v => {
                    service_1.host.setOpts(v.options);
                    return pxtc.transpile.tsToPy(service_1.service.getProgram(), v.fileName);
                },
                decompileSnippets: v => {
                    service_1.host.setOpts(v.options);
                    return pxtc.decompileSnippets(service_1.service.getProgram(), v.options, false);
                },
                assemble: v => {
                    return {
                        words: pxtc.processorInlineAssemble(service_1.host.opts.target, v.fileContent)
                    };
                },
                py2ts: v => {
                    addApiInfo(v.options);
                    return pxtc.transpile.pyToTs(v.options);
                },
                fileDiags: v => pxtc.patchUpDiagnostics(fileDiags(v.fileName)),
                allDiags: () => {
                    // not comapatible with incremental compilation
                    // host.opts.noEmit = true
                    // TODO: "allDiags" sounds like it's just reading state
                    // but it's actually kicking off a full compile. We should
                    // do better about caching and returning cached results from
                    // previous compiles.
                    let res = runConversionsAndCompileUsingService();
                    pxtc.timesToMs(res);
                    if (service_1.host.opts.target.switches.time)
                        console.log("DIAG-TIME", res.times);
                    return res;
                },
                format: v => {
                    const formatOptions = v.format;
                    return pxtc.format(formatOptions.input, formatOptions.pos);
                },
                apiInfo: () => {
                    service_1.lastBlocksInfo = undefined;
                    lastFuse = undefined;
                    if (service_1.host.opts === emptyOptions) {
                        // Host was reset, don't load apis with empty options
                        return undefined;
                    }
                    service_1.lastApiInfo = pxtc.internalGetApiInfo(service_1.service.getProgram(), service_1.host.opts.jres);
                    return service_1.lastApiInfo.apis;
                },
                snippet: v => {
                    const o = v.snippet;
                    if (!service_1.lastApiInfo)
                        return undefined;
                    const fn = service_1.lastApiInfo.apis.byQName[o.qName];
                    const n = service_1.lastApiInfo.decls[o.qName];
                    if (!fn || !n || !ts.isFunctionLike(n))
                        return undefined;
                    const isPython = !!o.python;
                    // determine which names are taken for auto-generated variable names
                    let takenNames = {};
                    if (isPython && service_1.lastGlobalNames) {
                        takenNames = service_1.lastGlobalNames;
                    }
                    else {
                        takenNames = service_1.lastApiInfo.apis.byQName;
                    }
                    const { bannedCategories, screenSize } = v.runtime;
                    const { apis } = service_1.lastApiInfo;
                    const blocksInfo = blocksInfoOp(apis, bannedCategories);
                    const checker = service_1.service && service_1.service.getProgram().getTypeChecker();
                    const snippetContext = {
                        apis,
                        blocksInfo,
                        takenNames,
                        bannedCategories,
                        screenSize,
                        checker,
                    };
                    const snippetNode = service_1.getSnippet(snippetContext, fn, n, isPython);
                    const snippet = service_1.snippetStringify(snippetNode);
                    return snippet;
                },
                blocksInfo: v => blocksInfoOp(v, v.blocks && v.blocks.bannedCategories),
                apiSearch: v => {
                    const SEARCH_RESULT_COUNT = 7;
                    const search = v.search;
                    const blockInfo = blocksInfoOp(search.localizedApis, v.blocks && v.blocks.bannedCategories); // caches
                    if (search.localizedStrings) {
                        pxt.Util.setLocalizedStrings(search.localizedStrings);
                    }
                    // Computes the preferred tooltip or block text to use for search (used for blocks that have multiple tooltips or block texts)
                    const computeSearchProperty = (tooltipOrBlock, preferredSearch, blockDef) => {
                        if (!tooltipOrBlock) {
                            return undefined;
                        }
                        if (typeof tooltipOrBlock === "string") {
                            // There is only one tooltip or block text; use it
                            return tooltipOrBlock;
                        }
                        if (preferredSearch) {
                            // The block definition specifies a preferred tooltip / block text to use for search; use it
                            return tooltipOrBlock[preferredSearch];
                        }
                        // The block definition does not specify which tooltip or block text to use for search; join all values with a space
                        return Object.keys(tooltipOrBlock).map(k => tooltipOrBlock[k]).join(" ");
                    };
                    // Fill default parameters in block string
                    const computeBlockString = (symbol) => {
                        var _a;
                        if ((_a = symbol.attributes) === null || _a === void 0 ? void 0 : _a._def) {
                            let block = [];
                            const blockDef = symbol.attributes._def;
                            const compileInfo = pxt.blocks.compileInfo(symbol);
                            // Construct block string from parsed blockdef
                            for (let part of blockDef.parts) {
                                switch (part.kind) {
                                    case "label":
                                        block.push(part.text);
                                        break;
                                    case "param":
                                        // In order, preference default value, var name, param name, blockdef param name
                                        let actualParam = compileInfo.definitionNameToParam[part.name];
                                        block.push((actualParam === null || actualParam === void 0 ? void 0 : actualParam.defaultValue)
                                            || part.varName
                                            || (actualParam === null || actualParam === void 0 ? void 0 : actualParam.actualName)
                                            || part.name);
                                        break;
                                }
                            }
                            return block.join(" ");
                        }
                        return symbol.attributes.block;
                    };
                    // Join parameter jsdoc into a string
                    const computeParameterString = (symbol) => {
                        var _a;
                        const paramHelp = (_a = symbol.attributes) === null || _a === void 0 ? void 0 : _a.paramHelp;
                        if (paramHelp) {
                            Object.keys(paramHelp).map(p => paramHelp[p]).join(" ");
                        }
                        return "";
                    };
                    if (!service_1.builtinItems) {
                        service_1.builtinItems = [];
                        service_1.blockDefinitions = pxt.blocks.blockDefinitions();
                        for (const id in service_1.blockDefinitions) {
                            const blockDef = service_1.blockDefinitions[id];
                            if (blockDef.operators) {
                                for (const op in blockDef.operators) {
                                    const opValues = blockDef.operators[op];
                                    opValues.forEach(v => service_1.builtinItems.push({
                                        id,
                                        name: blockDef.name,
                                        jsdoc: typeof blockDef.tooltip === "string" ? blockDef.tooltip : blockDef.tooltip[v],
                                        block: v,
                                        field: [op, v],
                                        builtinBlock: true
                                    }));
                                }
                            }
                            else {
                                service_1.builtinItems.push({
                                    id,
                                    name: blockDef.name,
                                    jsdoc: computeSearchProperty(blockDef.tooltip, blockDef.tooltipSearch, blockDef),
                                    block: computeSearchProperty(blockDef.block, blockDef.blockTextSearch, blockDef),
                                    builtinBlock: true
                                });
                            }
                        }
                    }
                    let subset;
                    const fnweight = (fn) => {
                        const fnw = fn.attributes.weight || 50;
                        const nsInfo = blockInfo.apis.byQName[fn.namespace];
                        const nsw = nsInfo ? (nsInfo.attributes.weight || 50) : 50;
                        const ad = (nsInfo ? nsInfo.attributes.advanced : false) || fn.attributes.advanced;
                        const weight = (nsw * 1000 + fnw) * (ad ? 1 : 1e6);
                        return weight;
                    };
                    if (!lastFuse || search.subset) {
                        const weights = {};
                        let builtinSearchSet = [];
                        if (search.subset) {
                            service_1.tbSubset = search.subset;
                            builtinSearchSet = service_1.builtinItems.filter(s => !!service_1.tbSubset[s.id]);
                        }
                        if (service_1.tbSubset) {
                            subset = blockInfo.blocks.filter(s => !!service_1.tbSubset[s.attributes.blockId]);
                        }
                        else {
                            subset = blockInfo.blocks;
                            builtinSearchSet = service_1.builtinItems;
                        }
                        let searchSet = subset.map(s => {
                            const mappedSi = {
                                id: s.attributes.blockId,
                                qName: s.qName,
                                name: s.name,
                                namespace: s.namespace,
                                block: computeBlockString(s),
                                params: computeParameterString(s),
                                jsdoc: s.attributes.jsDoc,
                                localizedCategory: service_1.tbSubset && typeof service_1.tbSubset[s.attributes.blockId] === "string"
                                    ? service_1.tbSubset[s.attributes.blockId] : undefined,
                            };
                            return mappedSi;
                        });
                        // filter out built-ins from the main search set as those
                        // should come from the built-in search set
                        let builtinBlockIds = {};
                        builtinSearchSet.forEach(b => builtinBlockIds[b.id] = true);
                        searchSet = searchSet.filter(b => !(b.id in builtinBlockIds));
                        let mw = 0;
                        subset.forEach(b => {
                            const w = weights[b.qName] = fnweight(b);
                            mw = Math.max(mw, w);
                        });
                        searchSet = searchSet.concat(builtinSearchSet);
                        const fuseOptions = {
                            shouldSort: true,
                            threshold: 0.6,
                            location: 0,
                            distance: 100,
                            maxPatternLength: 16,
                            minMatchCharLength: 2,
                            findAllMatches: false,
                            caseSensitive: false,
                            keys: [
                                { name: 'name', weight: 0.3 },
                                { name: 'namespace', weight: 0.1 },
                                { name: 'localizedCategory', weight: 0.1 },
                                { name: 'block', weight: 0.4375 },
                                { name: 'params', weight: 0.0625 },
                                { name: 'jsdoc', weight: 0.0625 }
                            ],
                            sortFn: function (a, b) {
                                const wa = a.qName ? 1 - weights[a.item.qName] / mw : 1;
                                const wb = b.qName ? 1 - weights[b.item.qName] / mw : 1;
                                // allow 10% wiggle room for weights
                                return a.score * (1 + wa / 10) - b.score * (1 + wb / 10);
                            }
                        };
                        lastFuse = new Fuse(searchSet, fuseOptions);
                    }
                    const fns = lastFuse.search(search.term);
                    return fns.slice(0, SEARCH_RESULT_COUNT);
                },
                projectSearch: v => {
                    const search = v.projectSearch;
                    const searchSet = search.headers;
                    if (!lastProjectFuse) {
                        const fuseOptions = {
                            shouldSort: true,
                            threshold: 0.6,
                            location: 0,
                            distance: 100,
                            maxPatternLength: 16,
                            minMatchCharLength: 2,
                            findAllMatches: false,
                            caseSensitive: false,
                            keys: [
                                { name: 'name', weight: 0.3 }
                            ]
                        };
                        lastProjectFuse = new Fuse(searchSet, fuseOptions);
                    }
                    const fns = lastProjectFuse.search(search.term);
                    return fns;
                },
                projectSearchClear: () => {
                    lastProjectFuse = undefined;
                }
            };
            function runConversionsAndCompileUsingService() {
                addApiInfo(service_1.host.opts);
                const prevFS = pxtc.U.flatClone(service_1.host.opts.fileSystem);
                let res = pxtc.runConversionsAndStoreResults(service_1.host.opts);
                if (res === null || res === void 0 ? void 0 : res.globalNames) {
                    service_1.lastGlobalNames = res.globalNames;
                }
                const newFS = service_1.host.opts.fileSystem;
                service_1.host.opts.fileSystem = prevFS;
                for (let k of Object.keys(newFS))
                    service_1.host.setFile(k, newFS[k]); // update version numbers
                if (res.diagnostics.length == 0) {
                    service_1.host.opts.skipPxtModulesEmit = false;
                    service_1.host.opts.skipPxtModulesTSC = false;
                    const currKey = service_1.host.opts.target.isNative ? "native" : "js";
                    if (!service_1.host.opts.target.switches.noIncr && service_1.host.pxtModulesOK) {
                        service_1.host.opts.skipPxtModulesTSC = true;
                        if (service_1.host.opts.noEmit)
                            service_1.host.opts.skipPxtModulesEmit = true;
                        else if (service_1.host.opts.target.isNative)
                            service_1.host.opts.skipPxtModulesEmit = false;
                        // don't cache emit when debugging pxt_modules/*
                        else if (service_1.host.pxtModulesOK == "js" && (!service_1.host.opts.breakpoints || service_1.host.opts.justMyCode))
                            service_1.host.opts.skipPxtModulesEmit = true;
                    }
                    let ts2asm = pxtc.compile(service_1.host.opts, service_1.service);
                    res = Object.assign({ sourceMap: res.sourceMap }, ts2asm);
                    if (res.needsFullRecompile || ((!res.success || res.diagnostics.length) && service_1.host.opts.clearIncrBuildAndRetryOnError)) {
                        pxt.debug("triggering full recompile");
                        pxt.tickEvent("compile.fullrecompile");
                        service_1.host.opts.skipPxtModulesEmit = false;
                        ts2asm = pxtc.compile(service_1.host.opts, service_1.service);
                        res = Object.assign({ sourceMap: res.sourceMap }, ts2asm);
                    }
                    if (res.diagnostics.every(d => !pxtc.isPxtModulesFilename(d.fileName)))
                        service_1.host.pxtModulesOK = currKey;
                    if (res.ast) {
                        // keep api info up to date after each compile
                        let ai = pxtc.internalGetApiInfo(res.ast);
                        if (ai)
                            service_1.lastApiInfo = ai;
                    }
                }
                return res;
            }
            service_1.runConversionsAndCompileUsingService = runConversionsAndCompileUsingService;
            function performOperation(op, arg) {
                init();
                let res = null;
                if (operations.hasOwnProperty(op)) {
                    try {
                        let opFn = operations[op];
                        res = opFn(arg) || {};
                    }
                    catch (e) {
                        res = {
                            errorMessage: e.stack
                        };
                    }
                }
                else {
                    res = {
                        errorMessage: "No such operation: " + op
                    };
                }
                return res;
            }
            service_1.performOperation = performOperation;
            function init() {
                if (!service_1.service) {
                    service_1.host = new Host();
                    service_1.service = ts.createLanguageService(service_1.host);
                }
            }
        })(service = pxtc.service || (pxtc.service = {}));
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        var service;
        (function (service) {
            const defaultTsImgList = `\`
. . . . .
. . . . .
. . # . .
. . . . .
. . . . .
\``;
            const defaultPyImgList = `"""
. . . . .
. . . . .
. . # . .
. . . . .
. . . . .
"""`;
            function isSnippetReplacePoint(n) {
                return typeof (n) === "object" && n.default !== undefined;
            }
            function isSnippetNodeList(n) {
                return typeof (n) === "object" && typeof (n.length) === "number";
            }
            function snippetStringify(snippet, emitMonacoReplacementPoints = false) {
                const namesToReplacementNumbers = {};
                let nextNum = 1;
                return internalSnippetStringify(snippet);
                function internalSnippetStringify(snippet) {
                    // The format for monaco snippets is:
                    //      foo(${1:bar}, ${2:baz},  ${1:bar})
                    // so both instances of "bar" will start highlighted, then tab will cycle to "baz", etc.
                    if (isSnippetReplacePoint(snippet)) {
                        if (emitMonacoReplacementPoints) {
                            if (snippetHasReplacementPoints(snippet.default)) {
                                return internalSnippetStringify(snippet.default);
                            }
                            const name = snippetStringify(snippet.default, false);
                            let num = namesToReplacementNumbers[name];
                            if (!num || snippet.isLiteral) {
                                num = nextNum;
                                nextNum++;
                                namesToReplacementNumbers[name] = num;
                            }
                            if (name.indexOf(".") >= 0 && name.indexOf(" ") < 0) {
                                // heuristic: if we're going to have a replacement for a qualified name, only
                                // replace the last part. E.g. "SpriteEffects.spray" we want "SpriteEffects.${spray}" not "${SpriteEffects.spray}"
                                let nmParts = name.split(".");
                                nmParts[nmParts.length - 1] = "${" + num + ":" + nmParts[nmParts.length - 1] + "}";
                                return nmParts.join(".");
                            }
                            else {
                                return "${" + num + ":" + name + "}";
                            }
                        }
                        else {
                            return internalSnippetStringify(snippet.default);
                        }
                    }
                    else if (isSnippetNodeList(snippet)) {
                        return snippet
                            .map(s => internalSnippetStringify(s))
                            .join("");
                    }
                    else {
                        return snippet;
                    }
                }
            }
            service.snippetStringify = snippetStringify;
            function snippetHasReplacementPoints(snippet) {
                if (isSnippetReplacePoint(snippet)) {
                    return true;
                }
                else if (isSnippetNodeList(snippet)) {
                    return snippet
                        .map(snippetHasReplacementPoints)
                        .reduce((p, n) => p || n, false);
                }
                else {
                    return false;
                }
            }
            service.snippetHasReplacementPoints = snippetHasReplacementPoints;
            function snippetAddsDefinitions(snippet) {
                if (isSnippetReplacePoint(snippet)) {
                    return snippet.isDefinition || snippetAddsDefinitions(snippet.default);
                }
                else if (isSnippetNodeList(snippet)) {
                    return snippet
                        .map(snippetAddsDefinitions)
                        .reduce((p, n) => p || n, false);
                }
                else {
                    return false;
                }
            }
            service.snippetAddsDefinitions = snippetAddsDefinitions;
            function getSnippet(context, fn, decl, python, recursionDepth = 0) {
                var _a;
                // TODO: a lot of this is duplicate logic with blocklyloader.ts:buildBlockFromDef; we should
                //  unify these approaches
                let { apis, takenNames, blocksInfo, screenSize, checker } = context;
                const PY_INDENT = pxt.py.INDENT;
                const fileType = python ? "python" : "typescript";
                let snippetPrefix = fn.namespace;
                let isInstance = false;
                let addNamespace = false;
                let namespaceToUse = "";
                let functionCount = 0;
                let preStmt = [];
                if (isTaggedTemplate(fn)) {
                    if (python) {
                        return `${fn.name}(""" """)`;
                    }
                    else {
                        return `${fn.name}\`\``;
                    }
                }
                let fnName = "";
                if (decl.kind == pxtc.SK.Constructor) {
                    fnName = getSymbolName(decl.symbol) || decl.parent.name.getText();
                }
                else {
                    fnName = getSymbolName(decl.symbol) || decl.name.getText();
                }
                if (python)
                    fnName = pxtc.U.snakify(fnName);
                const attrs = fn.attributes;
                if (attrs.shim === "TD_ID" && recursionDepth && decl.parameters.length) {
                    return getParameterDefault(decl.parameters[0]);
                }
                const element = fn;
                const params = pxt.blocks.compileInfo(element);
                const blocksById = blocksInfo.blocksById;
                // TODO: move out of getSnippet for general reuse
                const blockParameters = ((_a = attrs._def) === null || _a === void 0 ? void 0 : _a.parameters.filter(param => !!params.definitionNameToParam[param.name]).map(param => params.definitionNameToParam[param.name].actualName)) || [];
                const includedParameters = decl.parameters ? decl.parameters
                    // Only keep required parameters and parameters included in the blockdef
                    .filter(param => (!param.initializer && !param.questionToken)
                    || (blockParameters.indexOf(param.name.getText()) >= 0)) : [];
                const args = includedParameters
                    .map(getParameterDefault)
                    .map(p => 
                // make a "replacement point" out of each parameter
                // e.g. foo(${1:param1}, ${2:param2})
                ({
                    default: p,
                    isLiteral: true
                }));
                if (element.attributes.block) {
                    if (element.attributes.defaultInstance) {
                        snippetPrefix = element.attributes.defaultInstance;
                        if (python && snippetPrefix)
                            snippetPrefix = pxtc.U.snakify(snippetPrefix);
                    }
                    else if (element.namespace) { // some blocks don't have a namespace such as parseInt
                        const nsInfo = apis.byQName[element.namespace];
                        if (nsInfo.attributes.fixedInstances) {
                            let instances = pxtc.Util.values(apis.byQName);
                            let getExtendsTypesFor = function (name) {
                                return instances
                                    .filter(v => v.extendsTypes)
                                    .filter(v => v.extendsTypes.reduce((x, y) => x || y.indexOf(name) != -1, false))
                                    .reduce((x, y) => x.concat(y.extendsTypes), []);
                            };
                            // all fixed instances for this namespace
                            let fixedInstances = instances.filter(value => value.kind === 4 /* Variable */ &&
                                value.attributes.fixedInstance);
                            let instanceToUse;
                            // first try to get fixed instances whose retType matches nsInfo.name
                            // e.g., DigitalPin
                            const exactInstances = fixedInstances.filter(value => value.retType == nsInfo.qName)
                                .sort((v1, v2) => v1.name.localeCompare(v2.name));
                            if (exactInstances.length) {
                                instanceToUse = exactInstances[0];
                            }
                            else {
                                // second choice: use fixed instances whose retType extends type of nsInfo.name
                                // e.g., nsInfo.name == AnalogPin and instance retType == PwmPin
                                const extendedInstances = fixedInstances.filter(value => getExtendsTypesFor(nsInfo.qName).indexOf(value.retType) !== -1)
                                    .sort((v1, v2) => v1.name.localeCompare(v2.name));
                                instanceToUse = extendedInstances[0];
                            }
                            if (instanceToUse) {
                                snippetPrefix = `${getName(instanceToUse)}`;
                                namespaceToUse = instanceToUse.namespace;
                            }
                            else {
                                namespaceToUse = nsInfo.namespace;
                            }
                            if (namespaceToUse) {
                                addNamespace = true;
                            }
                            isInstance = true;
                        }
                        else if (element.kind == 1 /* Method */ || element.kind == 2 /* Property */) {
                            if (params.thisParameter) {
                                let varName = undefined;
                                if (params.thisParameter.definitionName) {
                                    varName = params.thisParameter.definitionName;
                                    varName = varName[0].toUpperCase() + varName.substring(1);
                                    varName = `my${varName}`;
                                }
                                snippetPrefix = params.thisParameter.defaultValue || varName;
                                if (python && snippetPrefix)
                                    snippetPrefix = pxtc.U.snakify(snippetPrefix);
                            }
                            isInstance = true;
                        }
                        else if (nsInfo.kind === 8 /* Class */) {
                            return undefined;
                        }
                    }
                }
                const preDefinedSnippet = attrs && (python ? attrs.pySnippet : attrs.snippet);
                let snippet;
                if (preDefinedSnippet) {
                    snippet = [preDefinedSnippet];
                }
                else {
                    snippet = [fnName];
                    if ((args === null || args === void 0 ? void 0 : args.length) || element.kind == 1 /* Method */ || element.kind == 3 /* Function */ || element.kind == 8 /* Class */) {
                        const argsWithCommas = args.reduce((p, n) => [...p, p.length ? ", " : "", n], []);
                        snippet = snippet.concat(["(", ...argsWithCommas, ")"]);
                    }
                }
                let insertText = snippetPrefix ? [snippetPrefix, ".", ...snippet] : snippet;
                insertText = addNamespace ? [firstWord(namespaceToUse), ".", ...insertText] : insertText;
                if (attrs && attrs.blockSetVariable) {
                    if (python) {
                        const varName = getUniqueName(pxtc.U.snakify(attrs.blockSetVariable));
                        const varNode = {
                            default: varName,
                            isDefinition: true
                        };
                        insertText = [varNode, " = ", ...insertText];
                    }
                    else {
                        const varName = getUniqueName(attrs.blockSetVariable);
                        const varNode = {
                            default: varName,
                            isDefinition: true
                        };
                        insertText = ["let ", varNode, " = ", ...insertText];
                    }
                }
                return [preStmt, insertText];
                function getUniqueName(inName) {
                    if (takenNames[inName])
                        return ts.pxtc.decompiler.getNewName(inName, takenNames, false);
                    return inName;
                }
                function getParameterDefault(param) {
                    var _a;
                    const typeNode = param.type;
                    if (!typeNode)
                        return python ? "None" : "null";
                    const name = param.name.kind === pxtc.SK.Identifier ? param.name.text : undefined;
                    // check for explicit default in the attributes
                    const paramDefl = (_a = attrs === null || attrs === void 0 ? void 0 : attrs.paramDefl) === null || _a === void 0 ? void 0 : _a[name];
                    if (paramDefl) {
                        let deflKind;
                        if (typeNode.kind == pxtc.SK.AnyKeyword) {
                            const defaultName = paramDefl.toUpperCase();
                            if (!Number.isNaN(+defaultName)) {
                                // try to parse as a number
                                deflKind = pxtc.SK.NumberKeyword;
                            }
                            else if (defaultName == "FALSE" || defaultName == "TRUE") {
                                // try to parse as a bool
                                deflKind = pxtc.SK.BooleanKeyword;
                            }
                            else if (defaultName.includes(".")) {
                                // try to parse as an enum
                                deflKind = pxtc.SK.EnumKeyword;
                            }
                            else {
                                // otherwise it'll be a string
                                deflKind = pxtc.SK.StringKeyword;
                            }
                        }
                        if (typeNode.kind === pxtc.SK.StringKeyword || deflKind === pxtc.SK.StringKeyword) {
                            return paramDefl.indexOf(`"`) != 0 ? `"${paramDefl}"` : paramDefl;
                        }
                        const type = checker === null || checker === void 0 ? void 0 : checker.getTypeAtLocation(param);
                        const typeSymbol = service.getPxtSymbolFromTsSymbol(type === null || type === void 0 ? void 0 : type.symbol, apis, checker);
                        if ((typeSymbol === null || typeSymbol === void 0 ? void 0 : typeSymbol.attributes.fixedInstances) && python) {
                            return pxt.Util.snakify(paramDefl);
                        }
                        if (python) {
                            return pxtc.tsSnippetToPySnippet(paramDefl, typeSymbol);
                        }
                        return paramDefl;
                    }
                    let shadowDefFromFieldEditor = getDefaultValueFromFieldEditor(name);
                    if (shadowDefFromFieldEditor) {
                        return shadowDefFromFieldEditor;
                    }
                    // check if there's a shadow override defined
                    let shadowSymbol = getShadowSymbol(name);
                    if (shadowSymbol) {
                        let tsSymbol = service.getTsSymbolFromPxtSymbol(shadowSymbol, param, ts.SymbolFlags.Enum);
                        if (tsSymbol) {
                            let shadowType = checker.getTypeOfSymbolAtLocation(tsSymbol, param);
                            if (shadowType) {
                                let shadowDef = getDefaultValueOfType(shadowType);
                                if (shadowDef) {
                                    return shadowDef;
                                }
                            }
                        }
                        const shadowAttrs = shadowSymbol.attributes;
                        if (shadowAttrs.shim === "KIND_GET" && shadowAttrs.blockId) {
                            const kindNamespace = shadowAttrs.kindNamespace || fn.namespace;
                            const defaultValueForKind = pxtc.Util.values(apis.byQName).find(api => api.namespace === kindNamespace && api.attributes.isKind);
                            if (defaultValueForKind) {
                                return python ? defaultValueForKind.pyQName : defaultValueForKind.qName;
                            }
                        }
                        // 3 is completely arbitrarily chosen here
                        if (recursionDepth < 3 && service.lastApiInfo.decls[shadowSymbol.qName]) {
                            let snippet = getSnippet(context, shadowSymbol, service.lastApiInfo.decls[shadowSymbol.qName], python, recursionDepth + 1);
                            if (snippet)
                                return snippet;
                        }
                    }
                    // HACK: special handling for single-color (e.g. micro:bit) image literal
                    if (typeNode.kind === pxtc.SK.StringKeyword && name === "leds") {
                        return python ? defaultPyImgList : defaultTsImgList;
                    }
                    // handle function types
                    if (typeNode.kind === pxtc.SK.FunctionType) {
                        const tn = typeNode;
                        let functionSignature = checker ? checker.getSignatureFromDeclaration(tn) : undefined;
                        if (functionSignature) {
                            return createDefaultFunction(functionSignature, true);
                        }
                        return emitEmptyFn(name);
                    }
                    // simple types we can determine defaults for
                    const basicRes = service.getBasicKindDefault(typeNode.kind, python);
                    if (basicRes !== undefined) {
                        return basicRes;
                    }
                    // get default of Typescript type
                    let type = checker && checker.getTypeAtLocation(param);
                    if (type) {
                        let typeDef = getDefaultValueOfType(type);
                        if (typeDef)
                            return typeDef;
                    }
                    // lastly, null or none
                    return python ? "None" : "null";
                }
                function getDefaultValueOfType(type) {
                    // TODO: generalize this to handle more types
                    if (type.symbol && type.symbol.flags & ts.SymbolFlags.Enum) {
                        const defl = service.getDefaultEnumValue(type, python);
                        return defl;
                    }
                    const typeSymbol = service.getPxtSymbolFromTsSymbol(type.symbol, apis, checker);
                    if (pxtc.isObjectType(type)) {
                        const snip = typeSymbol && typeSymbol.attributes && (python ? typeSymbol.attributes.pySnippet : typeSymbol.attributes.snippet);
                        if (snip)
                            return snip;
                        if (type.objectFlags & ts.ObjectFlags.Anonymous) {
                            const sigs = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
                            if (sigs && sigs.length) {
                                return createDefaultFunction(sigs[0], false);
                            }
                            return emitEmptyFn();
                        }
                    }
                    if (type.flags & ts.TypeFlags.NumberLike) {
                        return "0";
                    }
                    // check for fixed instances
                    if (typeSymbol && typeSymbol.attributes.fixedInstances) {
                        const fixedSyms = getFixedInstancesOf(typeSymbol);
                        if (fixedSyms.length) {
                            const defl = fixedSyms[0];
                            return python ? defl.pyQName : defl.qName;
                        }
                    }
                    return undefined;
                }
                function getFixedInstancesOf(type) {
                    return pxt.Util.values(apis.byQName).filter(sym => sym.kind === 4 /* Variable */
                        && sym.attributes.fixedInstance
                        && isSubtype(apis, sym.retType, type.qName));
                }
                function isSubtype(apis, specific, general) {
                    if (specific == general)
                        return true;
                    let inf = apis.byQName[specific];
                    if (inf && inf.extendsTypes)
                        return inf.extendsTypes.indexOf(general) >= 0;
                    return false;
                }
                function snippetFromSpriteEditorParams(opts) {
                    // TODO: Generalize this to share implementation with FieldSpriteEditor in field_sprite.ts
                    const parsed = {
                        initColor: 0,
                        initWidth: 16,
                        initHeight: 16,
                    };
                    if (opts === null || opts === void 0 ? void 0 : opts.sizes) {
                        const pairs = opts.sizes.split(";");
                        const sizes = [];
                        for (let i = 0; i < pairs.length; i++) {
                            const pair = pairs[i].split(",");
                            if (pair.length !== 2) {
                                continue;
                            }
                            let width = parseInt(pair[0]);
                            let height = parseInt(pair[1]);
                            if (isNaN(width) || isNaN(height)) {
                                continue;
                            }
                            if (width < 0 && screenSize)
                                width = screenSize.width;
                            if (height < 0 && screenSize)
                                height = screenSize.height;
                            sizes.push([width, height]);
                        }
                        if (sizes.length > 0) {
                            parsed.initWidth = sizes[0][0];
                            parsed.initHeight = sizes[0][1];
                        }
                    }
                    parsed.initColor = withDefault(opts === null || opts === void 0 ? void 0 : opts.initColor, parsed.initColor);
                    parsed.initWidth = withDefault(opts === null || opts === void 0 ? void 0 : opts.initWidth, parsed.initWidth);
                    parsed.initHeight = withDefault(opts === null || opts === void 0 ? void 0 : opts.initHeight, parsed.initHeight);
                    return pxt.sprite.imageLiteralFromDimensions(parsed.initWidth, parsed.initHeight, parsed.initColor, fileType);
                    function withDefault(raw, def) {
                        const res = parseInt(raw);
                        if (isNaN(res)) {
                            return def;
                        }
                        return res;
                    }
                }
                function getDefaultValueFromFieldEditor(paramName) {
                    var _a, _b;
                    const compileInfo = pxt.blocks.compileInfo(fn);
                    const blockParam = (_a = compileInfo.parameters) === null || _a === void 0 ? void 0 : _a.find((p) => p.actualName === paramName);
                    if (!(blockParam === null || blockParam === void 0 ? void 0 : blockParam.shadowBlockId))
                        return null;
                    let sym = blocksById[blockParam.shadowBlockId];
                    if (!sym)
                        return null;
                    const fieldEditor = (_b = sym.attributes) === null || _b === void 0 ? void 0 : _b.paramFieldEditor;
                    if (!fieldEditor)
                        return null;
                    const fieldEditorName = fieldEditor[paramName];
                    if (!fieldEditorName)
                        return null;
                    const fieldEditorOptions = sym.attributes.paramFieldEditorOptions || {};
                    switch (fieldEditorName) {
                        // TODO: Generalize this to share editor mapping with blocklycustomeditor.ts
                        case "sprite": return snippetFromSpriteEditorParams(fieldEditorOptions[paramName]);
                        // TODO: Handle other field editor types
                    }
                    return null;
                }
                function getShadowSymbol(paramName) {
                    // TODO: generalize and unify this with getCompletions code
                    let shadowBlock = (attrs._shadowOverrides || {})[paramName];
                    if (!shadowBlock) {
                        const comp = pxt.blocks.compileInfo(fn);
                        for (const param of comp.parameters) {
                            if (param.actualName === paramName) {
                                shadowBlock = param.shadowBlockId;
                                break;
                            }
                        }
                    }
                    if (!shadowBlock)
                        return null;
                    let sym = blocksById[shadowBlock];
                    if (!sym)
                        return null;
                    if (sym.attributes.shim === "TD_ID" && sym.parameters.length) {
                        let realName = sym.parameters[0].type;
                        let realSym = apis.byQName[realName];
                        sym = realSym || sym;
                    }
                    return sym;
                }
                function getSymbolName(symbol) {
                    if (checker) {
                        const qName = pxtc.getFullName(checker, symbol);
                        const si = apis.byQName[qName];
                        if (si)
                            return getName(si);
                    }
                    return undefined;
                }
                function getName(si) {
                    return python ? si.pyName : si.name;
                }
                function firstWord(s) {
                    const i = s.indexOf('.');
                    return i < 0 ? s : s.substring(0, i);
                }
                function createDefaultFunction(functionSignature, isArgument) {
                    let returnValue = "";
                    let returnType = checker.getReturnTypeOfSignature(functionSignature);
                    if (returnType.flags & ts.TypeFlags.NumberLike)
                        returnValue = "return 0";
                    else if (returnType.flags & ts.TypeFlags.StringLike)
                        returnValue = "return \"\"";
                    else if (returnType.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral))
                        returnValue = python ? "return False" : "return false";
                    if (python) {
                        let functionArgument;
                        if (attrs.optionalVariableArgs)
                            functionArgument = `()`;
                        else
                            functionArgument = `(${functionSignature.parameters.map(p => p.name).join(', ')})`;
                        let n = fnName || "fn";
                        if (functionCount++ > 0)
                            n += functionCount;
                        if (isArgument && !/^on/i.test(n)) // forever -> on_forever
                            n = "on" + pxt.Util.capitalize(n);
                        // This is replicating the name hint behavior in the pydecompiler. We put the default
                        // enum value at the end of the function name
                        const enumParams = includedParameters.filter(p => {
                            const t = checker && checker.getTypeAtLocation(p);
                            return !!(t && t.symbol && t.symbol.flags & ts.SymbolFlags.Enum);
                        }).map(p => {
                            const snippet = snippetStringify(getParameterDefault(p));
                            const str = snippet.toLowerCase();
                            const index = str.lastIndexOf(".");
                            return index !== -1 ? str.substr(index + 1) : str;
                        }).join("_");
                        if (enumParams)
                            n += "_" + enumParams;
                        n = pxtc.U.snakify(n);
                        n = getUniqueName(n);
                        preStmt = [
                            ...preStmt, preStmt.length ? "\n" : "",
                            "def ", { default: n, isDefinition: true }, functionArgument, `:\n${PY_INDENT}`,
                            { default: returnValue || "pass" }, `\n`
                        ];
                        return {
                            default: n
                        };
                    }
                    else {
                        let functionArgument = "()";
                        if (!attrs.optionalVariableArgs) {
                            let displayParts = ts.mapToDisplayParts((writer) => {
                                checker.getSymbolDisplayBuilder().buildSignatureDisplay(functionSignature, writer, undefined, ts.TypeFormatFlags.UseFullyQualifiedType);
                            });
                            let displayPartsStr = ts.displayPartsToString(displayParts);
                            functionArgument = displayPartsStr.substr(0, displayPartsStr.lastIndexOf(":"));
                        }
                        return [`function`, functionArgument, ` {\n${PY_INDENT}`, { default: returnValue }, `\n}`];
                    }
                }
                function emitEmptyFn(n) {
                    if (python) {
                        n = n || "fn";
                        n = pxtc.U.snakify(n);
                        n = getUniqueName(n);
                        preStmt = [
                            ...preStmt, preStmt.length ? "\n" : "",
                            "def ", { default: n, isDefinition: true }, `():\n${PY_INDENT}`, { default: `pass` }, `\n`,
                        ];
                        return {
                            default: n
                        };
                    }
                    else
                        return `function () {}`;
                }
            }
            service.getSnippet = getSnippet;
            function isTaggedTemplate(sym) {
                return (sym.attributes.shim && sym.attributes.shim[0] == "@") || sym.attributes.pyConvertToTaggedTemplate;
            }
            service.isTaggedTemplate = isTaggedTemplate;
        })(service = pxtc.service || (pxtc.service = {}));
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
// TODO: enable reference so we don't need to use: (pxt as any).py
//      the issue is that this creates a circular dependency. This
//      is easily handled if we used proper TS modules.
//// <reference path="../../built/pxtpy.d.ts"/>
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        var transpile;
        (function (transpile) {
            const mainName = (l) => `main.${l}`;
            function pyToTs(options, filename = mainName("py")) {
                return pxt.py.py2ts(options);
            }
            transpile.pyToTs = pyToTs;
            function tsToPy(program, filename = mainName("ts")) {
                return pxt.py.decompileToPython(program, filename);
            }
            transpile.tsToPy = tsToPy;
        })(transpile = pxtc.transpile || (pxtc.transpile = {}));
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        function getParentCallExpression(tsNode) {
            const pred = (n) => {
                if (ts.isCallExpression(n))
                    return TraverseCheck.Found;
                else if (ts.isBlock(n))
                    return TraverseCheck.Abort;
                return TraverseCheck.Continue;
            };
            return traverseUp(tsNode, pred);
        }
        pxtc.getParentCallExpression = getParentCallExpression;
        function findCurrentCallArgIdx(call, tsNode, tsPos) {
            // does our cursor syntax node trivially map to an argument?
            let paramIdx = call.arguments
                .map(a => a === tsNode)
                .indexOf(true);
            if (paramIdx >= 0)
                return paramIdx;
            // is our cursor within the argument range?
            const inRange = call.arguments.pos <= tsPos && tsPos < call.end;
            if (!inRange)
                return -1;
            // no arguments?
            if (call.arguments.length === 0)
                return 0;
            // then find which argument we're refering to
            paramIdx = 0;
            for (let a of call.arguments) {
                if (a.end <= tsPos)
                    paramIdx++;
                else
                    break;
            }
            if (!call.arguments.hasTrailingComma)
                paramIdx = Math.max(0, paramIdx - 1);
            return paramIdx;
        }
        pxtc.findCurrentCallArgIdx = findCurrentCallArgIdx;
        let TraverseCheck;
        (function (TraverseCheck) {
            TraverseCheck[TraverseCheck["Found"] = 0] = "Found";
            TraverseCheck[TraverseCheck["Continue"] = 1] = "Continue";
            TraverseCheck[TraverseCheck["Abort"] = 2] = "Abort";
        })(TraverseCheck = pxtc.TraverseCheck || (pxtc.TraverseCheck = {}));
        function traverseUp(node, predicate) {
            if (!node)
                return undefined;
            const res = predicate(node);
            if (res === TraverseCheck.Continue)
                return traverseUp(node.parent, predicate);
            else if (res === TraverseCheck.Abort)
                return undefined;
            else if (res === TraverseCheck.Found)
                return node;
            let _ = res;
            return res;
        }
        pxtc.traverseUp = traverseUp;
        function enumMemberToQName(tc, e) {
            if (e.name.kind === pxtc.SK.Identifier) {
                return tc.getFullyQualifiedName(tc.getSymbolAtLocation(e.name));
            }
            return undefined;
        }
        pxtc.enumMemberToQName = enumMemberToQName;
        function findInnerMostNodeAtPosition(n, position) {
            for (let child of n.getChildren()) {
                if (child.kind >= ts.SyntaxKind.FirstPunctuation && child.kind <= ts.SyntaxKind.LastPunctuation)
                    continue;
                let s = child.getStart();
                let e = child.getEnd();
                if (s <= position && position < e)
                    return findInnerMostNodeAtPosition(child, position);
            }
            return (n && n.kind === pxtc.SK.SourceFile) ? null : n;
        }
        pxtc.findInnerMostNodeAtPosition = findInnerMostNodeAtPosition;
        function getParentNamespace(n) {
            return traverseUp(n, n => ts.isModuleDeclaration(n) ? TraverseCheck.Found : TraverseCheck.Continue);
        }
        pxtc.getParentNamespace = getParentNamespace;
        function getCurrentNamespaces(n) {
            if (!n)
                return [];
            let parent = getParentNamespace(n);
            if (!parent)
                return [];
            let ns = parent.name.getText();
            return [...getCurrentNamespaces(parent.parent), ns];
        }
        pxtc.getCurrentNamespaces = getCurrentNamespaces;
        function getEnumMembers(checker, t) {
            if (checker && t.symbol && t.symbol.declarations && t.symbol.declarations.length) {
                for (let i = 0; i < t.symbol.declarations.length; i++) {
                    const decl = t.symbol.declarations[i];
                    if (decl.kind === pxtc.SK.EnumDeclaration) {
                        const enumDeclaration = decl;
                        return enumDeclaration.members;
                    }
                }
            }
            return undefined;
        }
        pxtc.getEnumMembers = getEnumMembers;
        function isExported(decl) {
            if (decl.modifiers && decl.modifiers.some(m => m.kind == pxtc.SK.PrivateKeyword || m.kind == pxtc.SK.ProtectedKeyword))
                return false;
            let symbol = decl.symbol;
            if (!symbol)
                return false;
            while (true) {
                let parSymbol = symbol.parent;
                if (parSymbol)
                    symbol = parSymbol;
                else
                    break;
            }
            let topDecl = symbol.valueDeclaration || symbol.declarations[0];
            if (topDecl.kind == pxtc.SK.VariableDeclaration)
                topDecl = topDecl.parent.parent;
            if (topDecl.parent && topDecl.parent.kind == pxtc.SK.SourceFile)
                return true;
            else
                return false;
        }
        pxtc.isExported = isExported;
        function isReadonly(decl) {
            return decl.modifiers && decl.modifiers.some(m => m.kind == pxtc.SK.ReadonlyKeyword);
        }
        pxtc.isReadonly = isReadonly;
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
var ts;
(function (ts) {
    var pxtc;
    (function (pxtc) {
        var vm;
        (function (vm) {
            const emitErr = pxtc.assembler.emitErr;
            const badNameError = emitErr("opcode name doesn't match", "<name>");
            class VmInstruction extends pxtc.assembler.Instruction {
                constructor(ei, format, opcode) {
                    super(ei, format, opcode, opcode, false);
                }
                emit(ln) {
                    let tokens = ln.words;
                    if (tokens[0] != this.name)
                        return badNameError;
                    let opcode = this.opcode;
                    let j = 1;
                    let stack = 0;
                    let numArgs = [];
                    let labelName = null;
                    let opcode2 = null;
                    let i2 = null;
                    for (let i = 0; i < this.args.length; ++i) {
                        let formal = this.args[i];
                        let actual = tokens[j++];
                        if (formal[0] == "$") {
                            let enc = this.ei.encoders[formal];
                            let v = null;
                            if (enc.isImmediate || enc.isLabel) {
                                if (!actual)
                                    return emitErr("expecting number", actual);
                                actual = actual.replace(/^#/, "");
                                v = ln.bin.parseOneInt(actual);
                                if (v == null)
                                    return emitErr("expecting number", actual);
                            }
                            else {
                                pxtc.oops();
                            }
                            if (v == null)
                                return emitErr("didn't understand it", actual);
                            pxtc.U.assert(v >= 0);
                            if (v != 11111 && formal == "$lbl") {
                                v -= ln.bin.location() + 2;
                                v >>= 1;
                            }
                            numArgs.push(v);
                            const v0 = v;
                            v = enc.encode(v);
                            if (v == null)
                                return emitErr(`argument (${v0}) out of range or mis-aligned`, actual);
                            if (formal == "$i3") {
                                v = i2 | (v << 6);
                            }
                            else if (formal == "$i5") {
                                v = i2 | (v << 8);
                            }
                            if (formal == "$i2" || formal == "$i4") {
                                i2 = v;
                            }
                            else if (formal == "$rt") {
                                if (v != 11111 && v > 0x1000) {
                                    pxtc.U.oops("label: " + actual + " v=" + v);
                                }
                                opcode = v | 0x8000;
                                if (this.name == "callrt.p")
                                    opcode |= 0x2000;
                            }
                            else if (ln.isLong || v < 0 || v > 255) {
                                // keep it long for the final pass; otherwise labels may shift
                                ln.isLong = true;
                                if (formal == "$lbl")
                                    v -= 1; // account for bigger encoding in relative addresses
                                opcode = ((v >> 9) & 0xffff) | 0xc000;
                                opcode2 = (this.opcode + (v << 7)) & 0xffff;
                            }
                            else {
                                opcode = (this.opcode + (v << 7)) & 0xffff;
                            }
                        }
                        else if (formal == actual) {
                            // skip
                        }
                        else {
                            return emitErr("expecting " + formal, actual);
                        }
                    }
                    if (tokens[j])
                        return emitErr("trailing tokens", tokens[j]);
                    return {
                        stack: stack,
                        opcode,
                        opcode2,
                        numArgs: numArgs,
                        labelName: ln.bin.normalizeExternalLabel(labelName)
                    };
                }
            }
            vm.VmInstruction = VmInstruction;
            vm.withPush = {};
            vm.opcodes = [
                "stloc     $i1",
                "ldloc     $i1",
                "stfld     $i4, $i5",
                "ldfld     $i4, $i5",
                "newobj    $i1",
                "ldcap     $i1",
                "bitconv   $i1",
                "stglb     $i1",
                "ldglb     $i1",
                "ldint     $i1",
                "ldintneg  $i1",
                "ldspecial $i1",
                "ldnumber  $i1",
                "ldlit     $i1",
                "checkinst $i1",
                "mapget",
                "mapset",
                "ret       $i2, $i3",
                "popmany   $i1",
                "pushmany  $i1",
                "callind   $i1",
                "callproc  $i1",
                "calliface $i2, $i3",
                "callget   $i1",
                "callset   $i1",
                "jmp       $lbl",
                "jmpnz     $lbl",
                "jmpz      $lbl",
                "try       $lbl",
                "push",
                "pop",
            ];
            class VmProcessor extends pxtc.assembler.AbstractProcessor {
                constructor(target) {
                    super();
                    this.addEnc("$i1", "#0-8388607", v => this.inrange(8388607, v, v));
                    this.addEnc("$i2", "#0-31", v => this.inrange(31, v, v));
                    this.addEnc("$i3", "#0-262143", v => this.inrange(262143, v, v));
                    this.addEnc("$i4", "#0-255", v => this.inrange(255, v, v));
                    this.addEnc("$i5", "#0-32767", v => this.inrange(32767, v, v));
                    this.addEnc("$lbl", "LABEL", v => this.inminmax(-4194304, 4194303, v, v)).isLabel = true;
                    this.addEnc("$rt", "SHIM", v => this.inrange(8388607, v, v)).isLabel = true;
                    let opId = 1;
                    let hasPush = true;
                    for (let opcode of vm.opcodes.concat(["callrt $rt"])) {
                        let ins = new VmInstruction(this, opcode, opId);
                        this.instructions[ins.name] = [ins];
                        if (hasPush || ins.name == "callrt") {
                            vm.withPush[ins.name] = true;
                            ins = new VmInstruction(this, opcode.replace(/\w+/, f => f + ".p"), opId | (1 << 6));
                            this.instructions[ins.name] = [ins];
                        }
                        if (ins.name == "mapset.p")
                            hasPush = false;
                        opId++;
                    }
                }
                testAssembler() {
                }
                postProcessRelAddress(f, v) {
                    return v;
                }
                postProcessAbsAddress(f, v) {
                    return v;
                }
                getAddressFromLabel(f, i, s, wordAligned = false) {
                    // lookup absolute, relative, dependeing
                    let l = f.lookupLabel(s);
                    if (l == null)
                        return null;
                    if (i.is32bit)
                        // absolute address
                        return l;
                    // relative address
                    return l - (f.pc() + 2);
                }
                toFnPtr(v, baseOff) {
                    return v;
                }
                wordSize() {
                    return 8;
                }
                peephole(ln, lnNext, lnNext2) {
                    let lnop = ln.getOp();
                    let lnop2 = "";
                    if (lnNext) {
                        lnop2 = lnNext.getOp();
                        let key = lnop + ";" + lnop2;
                        let pc = this.file.peepCounts;
                        pc[key] = (pc[key] || 0) + 1;
                    }
                    if (lnop == "stloc" && lnop2 == "ldloc" && ln.numArgs[0] == lnNext.numArgs[0]) {
                        if (/LAST/.test(lnNext.text))
                            ln.update("");
                        lnNext.update("");
                    }
                    else if (vm.withPush[lnop] && lnop2 == "push") {
                        ln.update(ln.text.replace(/\w+/, f => f + ".p"));
                        lnNext.update("");
                    }
                    /*
                    if (lnop == "jmp" && ln.numArgs[0] == this.file.baseOffset + lnNext.location) {
                        // RULE: jmp .somewhere; .somewhere: -> .somewhere:
                        ln.update("")
                    } else if (lnop == "push" && (
                        lnop2 == "callproc" || lnop2 == "ldconst" ||
                        lnop2 == "stringlit" || lnop2 == "ldtmp")) {
                        ln.update("")
                        lnNext.update("push_" + lnop2 + " " + lnNext.words[1])
                    } else if (lnop == "push" && (lnop2 == "ldzero" || lnop2 == "ldone")) {
                        ln.update("")
                        lnNext.update("push_" + lnop2)
                    } else if (lnop == "ldtmp" && (lnop2 == "incr" || lnop2 == "decr")) {
                        ln.update("ldtmp_" + lnop2 + " " + ln.words[1])
                        lnNext.update("")
                    }
                    */
                }
            }
            vm.VmProcessor = VmProcessor;
        })(vm = pxtc.vm || (pxtc.vm = {}));
    })(pxtc = ts.pxtc || (ts.pxtc = {}));
})(ts || (ts = {}));
