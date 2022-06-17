/// <reference path='../built/pxtlib.d.ts' />
/// <reference path='../built/pxtcompiler.d.ts' />
var pxt;
(function (pxt) {
    var py;
    (function (py) {
        let VarModifier;
        (function (VarModifier) {
            VarModifier[VarModifier["NonLocal"] = 0] = "NonLocal";
            VarModifier[VarModifier["Global"] = 1] = "Global";
        })(VarModifier = py.VarModifier || (py.VarModifier = {}));
        function isIndex(e) {
            return e.kind === "Index";
        }
        py.isIndex = isIndex;
        function isSubscript(e) {
            return e.kind === "Subscript";
        }
        py.isSubscript = isSubscript;
    })(py = pxt.py || (pxt.py = {}));
})(pxt || (pxt = {}));
var pxt;
(function (pxt) {
    var py;
    (function (py_1) {
        var B = pxt.blocks;
        // global state
        let externalApis; // slurped from libraries
        let internalApis; // defined in Python
        let ctx;
        let currIteration = 0;
        let typeId = 0;
        // this measures if we gained additional information about type state
        // we run conversion several times, until we have all information possible
        let numUnifies = 0;
        let autoImport = true;
        let currErrorCtx = "???";
        let verboseTypes = false;
        let lastAST = undefined;
        let lastFile;
        let diagnostics;
        let compileOptions;
        let syntaxInfo;
        let infoNode = undefined;
        let infoScope;
        // TODO: move to utils
        function isFalsy(t) {
            return t === null || t === undefined;
        }
        function isTruthy(t) {
            return t !== null && t !== undefined;
        }
        function stmtTODO(v) {
            pxt.tickEvent("python.todo.statement", { kind: v.kind });
            return B.mkStmt(B.mkText("TODO: " + v.kind));
        }
        function exprTODO(v) {
            pxt.tickEvent("python.todo.expression", { kind: v.kind });
            return B.mkText(" {TODO: " + v.kind + "} ");
        }
        function docComment(cmt) {
            if (cmt.trim().split(/\n/).length <= 1)
                cmt = cmt.trim();
            else
                cmt = cmt + "\n";
            return B.mkStmt(B.mkText("/** " + cmt + " */"));
        }
        function defName(n, tp) {
            return {
                kind: "Name",
                id: n,
                isdef: true,
                ctx: "Store",
                tsType: tp
            };
        }
        const tpString = mkType({ primType: "string" });
        const tpNumber = mkType({ primType: "number" });
        const tpBoolean = mkType({ primType: "boolean" });
        const tpVoid = mkType({ primType: "void" });
        const tpAny = mkType({ primType: "any" });
        let tpBuffer = undefined;
        const builtInTypes = {
            "str": tpString,
            "string": tpString,
            "number": tpNumber,
            "bool": tpBoolean,
            "void": tpVoid,
            "any": tpAny,
        };
        function ts2PyType(syntaxKind) {
            switch (syntaxKind) {
                case ts.SyntaxKind.StringKeyword:
                    return tpString;
                case ts.SyntaxKind.NumberKeyword:
                    return tpNumber;
                case ts.SyntaxKind.BooleanKeyword:
                    return tpBoolean;
                case ts.SyntaxKind.VoidKeyword:
                    return tpVoid;
                case ts.SyntaxKind.AnyKeyword:
                    return tpAny;
                default: {
                    // TODO: this could be null
                    return tpBuffer;
                }
            }
        }
        function cleanSymbol(s) {
            let r = pxt.U.flatClone(s);
            delete r.pyAST;
            delete r.pyInstanceType;
            delete r.pyRetType;
            delete r.pySymbolType;
            delete r.moduleTypeMarker;
            delete r.declared;
            if (r.parameters)
                r.parameters = r.parameters.map(p => {
                    p = pxt.U.flatClone(p);
                    delete p.pyType;
                    return p;
                });
            return r;
        }
        function mapTsType(tp) {
            // TODO handle specifc generic types like: SparseArray<number[]>
            // wrapped in (...)
            if (tp[0] == "(" && pxt.U.endsWith(tp, ")")) {
                return mapTsType(tp.slice(1, -1));
            }
            // lambda (...) => ...
            const arrowIdx = tp.indexOf(" => ");
            if (arrowIdx > 0) {
                const retTypeStr = tp.slice(arrowIdx + 4);
                if (retTypeStr.indexOf(")[]") == -1) {
                    const retType = mapTsType(retTypeStr);
                    const argsStr = tp.slice(1, arrowIdx - 1);
                    const argsWords = argsStr ? argsStr.split(/, /) : [];
                    const argTypes = argsWords.map(a => mapTsType(a.replace(/\w+\??: /, "")));
                    return mkFunType(retType, argTypes);
                }
            }
            // array ...[]
            if (pxt.U.endsWith(tp, "[]")) {
                return mkArrayType(mapTsType(tp.slice(0, -2)));
            }
            if (tp === "_py.Array") {
                return mkArrayType(tpAny);
            }
            // builtin
            const t = pxt.U.lookup(builtInTypes, tp);
            if (t)
                return t;
            // handle number litterals like "-20" (b/c TS loves to give specific types to const's)
            let isNum = !!tp && !isNaN(tp); // https://stackoverflow.com/questions/175739
            if (isNum)
                return tpNumber;
            // generic
            if (tp == "T" || tp == "U") // TODO hack!
                return mkType({ primType: "'" + tp });
            // union
            if (tp.indexOf("|") >= 0) {
                const parts = tp.split("|")
                    .map(p => p.trim());
                return mkType({
                    primType: "@union",
                    typeArgs: parts.map(mapTsType)
                });
            }
            // defined by a symbol,
            //  either in external (non-py) APIs (like default/common packages)
            //  or in internal (py) APIs (probably main.py)
            let sym = lookupApi(tp + "@type") || lookupApi(tp);
            if (!sym) {
                error(null, 9501, pxt.U.lf("unknown type '{0}' near '{1}'", tp, currErrorCtx || "???"));
                return mkType({ primType: tp });
            }
            if (sym.kind == 7 /* EnumMember */)
                return tpNumber;
            // sym.pyInstanceType might not be initialized yet and we don't want to call symbolType() here to avoid infinite recursion
            if (sym.kind == 8 /* Class */ || sym.kind == 9 /* Interface */)
                return sym.pyInstanceType || mkType({ classType: sym });
            if (sym.kind == 6 /* Enum */)
                return tpNumber;
            error(null, 9502, pxt.U.lf("'{0}' is not a type near '{1}'", tp, currErrorCtx || "???"));
            return mkType({ primType: tp });
        }
        function getOrSetSymbolType(sym) {
            if (!sym.pySymbolType) {
                currErrorCtx = sym.pyQName;
                if (sym.parameters) {
                    if (pxtc.service.isTaggedTemplate(sym)) {
                        sym.parameters = [{
                                "name": "literal",
                                "description": "",
                                "type": "string",
                                "options": {}
                            }];
                    }
                    for (let p of sym.parameters) {
                        if (!p.pyType)
                            p.pyType = mapTsType(p.type);
                    }
                }
                const prevRetType = sym.pyRetType;
                if (isModule(sym)) {
                    sym.pyRetType = mkType({ moduleType: sym });
                }
                else {
                    if (sym.retType)
                        sym.pyRetType = mapTsType(sym.retType);
                    else if (sym.pyRetType) {
                        // nothing to do
                    }
                    else {
                        pxt.U.oops("no type for: " + sym.pyQName);
                        sym.pyRetType = mkType({});
                    }
                }
                if (prevRetType) {
                    unify(sym.pyAST, prevRetType, sym.pyRetType);
                }
                if (sym.kind == 3 /* Function */ || sym.kind == 1 /* Method */) {
                    let paramTypes = sym.parameters.map(p => p.pyType);
                    if (paramTypes.some(isFalsy)) {
                        error(null, 9526, pxt.U.lf("function symbol is missing parameter types near '{1}'", currErrorCtx || "???"));
                        return mkType({});
                    }
                    sym.pySymbolType = mkFunType(sym.pyRetType, paramTypes.filter(isTruthy));
                }
                else
                    sym.pySymbolType = sym.pyRetType;
                if (sym.kind == 8 /* Class */ || sym.kind == 9 /* Interface */) {
                    sym.pyInstanceType = mkType({ classType: sym });
                }
                currErrorCtx = undefined;
            }
            return sym.pySymbolType;
        }
        function lookupApi(name) {
            return pxt.U.lookup(internalApis, name) || pxt.U.lookup(externalApis, name);
        }
        function lookupGlobalSymbol(name) {
            var _a;
            if (!name)
                return undefined;
            let sym = lookupApi(name);
            if (sym)
                getOrSetSymbolType(sym);
            else if (name.indexOf(".") && !name.endsWith(".__constructor")) {
                const base = name.substring(0, name.lastIndexOf("."));
                const baseSymbol = lookupGlobalSymbol(base);
                if ((baseSymbol === null || baseSymbol === void 0 ? void 0 : baseSymbol.kind) === 8 /* Class */ && ((_a = baseSymbol.extendsTypes) === null || _a === void 0 ? void 0 : _a.length)) {
                    return lookupGlobalSymbol(baseSymbol.extendsTypes[0] + name.substring(base.length));
                }
            }
            return sym;
        }
        function initApis(apisInfo, tsShadowFiles) {
            internalApis = {};
            externalApis = {};
            let tsShadowFilesSet = pxt.U.toDictionary(tsShadowFiles, t => t);
            for (let sym of pxt.U.values(apisInfo.byQName)) {
                if (tsShadowFilesSet.hasOwnProperty(sym.fileName)) {
                    continue;
                }
                let sym2 = sym;
                if (sym2.extendsTypes)
                    sym2.extendsTypes = sym2.extendsTypes.filter(e => e != sym2.qName);
                if (!sym2.pyQName || !sym2.qName) {
                    error(null, 9526, pxt.U.lf("Symbol '{0}' is missing qName for '{1}'", sym2.name, !sym2.pyQName ? "py" : "ts"));
                }
                externalApis[sym2.pyQName] = sym2;
                externalApis[sym2.qName] = sym2;
            }
            // TODO this is for testing mostly; we can do this lazily
            // for (let sym of U.values(externalApis)) {
            //     if (sym)
            //         getOrSetSymbolType(sym)
            // }
            tpBuffer = mapTsType("Buffer");
        }
        function mkType(o = {}) {
            let r = pxt.U.flatClone(o);
            r.tid = ++typeId;
            return r;
        }
        function mkArrayType(eltTp) {
            return mkType({ primType: "@array", typeArgs: [eltTp] });
        }
        function mkFunType(retTp, argTypes) {
            return mkType({ primType: "@fn" + argTypes.length, typeArgs: [retTp].concat(argTypes) });
        }
        function isFunType(t) {
            return !!pxt.U.startsWith(t.primType || "", "@fn");
        }
        function isPrimativeType(t) {
            return !!t.primType && !pxt.U.startsWith(t.primType, "@");
        }
        function isUnionType(t) {
            return !!pxt.U.startsWith(t.primType || "", "@union");
        }
        function instanceType(sym) {
            getOrSetSymbolType(sym);
            if (!sym.pyInstanceType)
                error(null, 9527, pxt.U.lf("Instance type symbol '{0}' is missing pyInstanceType", sym));
            return sym.pyInstanceType;
        }
        function currentScope() {
            return ctx.currFun || ctx.currClass || ctx.currModule;
        }
        function topScope() {
            let current = currentScope();
            while (current && current.parent) {
                current = current.parent;
            }
            return current;
        }
        function isTopLevel() {
            return ctx.currModule.name == "main" && !ctx.currFun && !ctx.currClass;
        }
        function addImport(a, name, scope) {
            const sym = lookupGlobalSymbol(name);
            if (!sym)
                error(a, 9503, pxt.U.lf("No module named '{0}'", name));
            return sym;
        }
        function defvar(name, opts, modifier, scope) {
            if (!scope)
                scope = currentScope();
            let varScopeSym = scope.vars[name];
            let varSym = varScopeSym === null || varScopeSym === void 0 ? void 0 : varScopeSym.symbol;
            if (!varSym) {
                let pref = getFullName(scope);
                if (pref) {
                    pref += ".";
                }
                let qualifiedName = pref + name;
                if (scope.kind === "ClassDef") {
                    varSym = addSymbol(2 /* Property */, qualifiedName);
                }
                else if (isLocalScope(scope)
                    && (modifier === py_1.VarModifier.Global
                        || modifier === py_1.VarModifier.NonLocal)) {
                    varSym = addSymbol(4 /* Variable */, name);
                }
                else if (isLocalScope(scope))
                    varSym = mkSymbol(4 /* Variable */, name);
                else
                    varSym = addSymbol(4 /* Variable */, qualifiedName);
                varScopeSym = {
                    symbol: varSym,
                    modifier,
                };
                scope.vars[name] = varScopeSym;
            }
            for (let k of Object.keys(opts)) {
                varSym[k] = opts[k];
            }
            return varScopeSym;
        }
        function canonicalize(t) {
            if (t.unifyWith) {
                t.unifyWith = canonicalize(t.unifyWith);
                return t.unifyWith;
            }
            return t;
        }
        // TODO cache it?
        function getFullName(n) {
            let s = n;
            let pref = "";
            if (s.parent && s.parent.kind !== "FunctionDef" && s.parent.kind !== "AsyncFunctionDef") {
                pref = getFullName(s.parent);
                if (!pref)
                    pref = "";
                else
                    pref += ".";
            }
            let nn = n;
            if (n.kind == "Module" && nn.name == "main")
                return "";
            if (nn.name)
                return pref + nn.name;
            else
                return pref + "?" + n.kind;
        }
        function applyTypeMap(s) {
            let over = pxt.U.lookup(typeMap, s);
            if (over)
                return over;
            for (let scopeVar of pxt.U.values(ctx.currModule.vars)) {
                let v = scopeVar.symbol;
                if (!v.isImport)
                    continue;
                if (v.expandsTo == s) {
                    if (!v.pyName)
                        error(null, 9553, lf("missing pyName"));
                    return v.pyName;
                }
                if (v.isImport && pxt.U.startsWith(s, (v.expandsTo || "") + ".")) {
                    return v.pyName + s.slice(v.expandsTo.length);
                }
            }
            return s;
        }
        function t2s(t) {
            t = canonicalize(t);
            const suff = (s) => verboseTypes ? s : "";
            if (t.primType) {
                if (t.typeArgs && t.primType == "@array") {
                    return t2s(t.typeArgs[0]) + "[]";
                }
                if (isFunType(t) && t.typeArgs)
                    return "(" + t.typeArgs.slice(1).map(t => "_: " + t2s(t)).join(", ") + ") => " + t2s(t.typeArgs[0]);
                if (isUnionType(t) && t.typeArgs) {
                    return t.typeArgs.map(t2s).join(" | ");
                }
                return t.primType + suff("/P");
            }
            if (t.classType && t.classType.pyQName)
                return applyTypeMap(t.classType.pyQName) + suff("/C");
            else if (t.moduleType && t.moduleType.pyQName)
                return applyTypeMap(t.moduleType.pyQName) + suff("/M");
            else
                return "any";
        }
        function mkDiag(astNode, category, code, messageText) {
            if (!astNode)
                astNode = lastAST;
            if (!astNode || !ctx || !ctx.currModule) {
                return {
                    fileName: lastFile,
                    start: 0,
                    length: 0,
                    line: undefined,
                    column: undefined,
                    code,
                    category,
                    messageText,
                };
            }
            else {
                return {
                    fileName: lastFile,
                    start: astNode.startPos,
                    length: astNode.endPos - astNode.startPos,
                    line: undefined,
                    column: undefined,
                    code,
                    category,
                    messageText,
                };
            }
        }
        // next free error 9576
        function error(astNode, code, msg) {
            diagnostics.push(mkDiag(astNode, pxtc.DiagnosticCategory.Error, code, msg));
            //const pos = position(astNode ? astNode.startPos || 0 : 0, mod.source)
            //currErrs += U.lf("{0} near {1}{2}", msg, mod.tsFilename.replace(/\.ts/, ".py"), pos) + "\n"
        }
        function typeError(a, t0, t1) {
            error(a, 9500, pxt.U.lf("types not compatible: {0} and {1}", t2s(t0), t2s(t1)));
        }
        function typeCtor(t) {
            if (t.primType)
                return t.primType;
            else if (t.classType)
                return t.classType;
            else if (t.moduleType) {
                // a class SymbolInfo can be used as both classType and moduleType
                // but these are different constructors (one is instance, one is class itself)
                if (!t.moduleType.moduleTypeMarker)
                    t.moduleType.moduleTypeMarker = {};
                return t.moduleType.moduleTypeMarker;
            }
            return null;
        }
        function isFree(t) {
            return !typeCtor(canonicalize(t));
        }
        function canUnify(t0, t1) {
            t0 = canonicalize(t0);
            t1 = canonicalize(t1);
            if (t0 === t1)
                return true;
            let c0 = typeCtor(t0);
            let c1 = typeCtor(t1);
            if (!c0 || !c1)
                return true;
            if (c0 !== c1)
                return false;
            if (t0.typeArgs && t1.typeArgs) {
                for (let i = 0; i < Math.min(t0.typeArgs.length, t1.typeArgs.length); ++i)
                    if (!canUnify(t0.typeArgs[i], t1.typeArgs[i]))
                        return false;
            }
            return true;
        }
        function unifyClass(a, t, cd) {
            t = canonicalize(t);
            if (t.classType == cd)
                return;
            if (isFree(t)) {
                t.classType = cd;
                return;
            }
            unify(a, t, instanceType(cd));
        }
        function unifyTypeOf(e, t1) {
            unify(e, typeOf(e), t1);
        }
        function unify(a, t0, t1) {
            if (t0 === t1)
                return;
            t0 = canonicalize(t0);
            t1 = canonicalize(t1);
            // We don't handle generic types yet, so bail out. Worst case
            // scenario is that we infer some extra types as "any"
            if (t0 === t1 || isGenericType(t0) || isGenericType(t1))
                return;
            if (t0.primType === "any") {
                t0.unifyWith = t1;
                return;
            }
            const c0 = typeCtor(t0);
            const c1 = typeCtor(t1);
            if (c0 && c1) {
                if (c0 === c1) {
                    t0.unifyWith = t1; // no type-state change here - actual change would be in arguments only
                    if (t0.typeArgs && t1.typeArgs) {
                        for (let i = 0; i < Math.min(t0.typeArgs.length, t1.typeArgs.length); ++i)
                            unify(a, t0.typeArgs[i], t1.typeArgs[i]);
                    }
                    t0.unifyWith = t1;
                }
                else {
                    typeError(a, t0, t1);
                }
            }
            else if (c0 && !c1) {
                unify(a, t1, t0);
            }
            else {
                // the type state actually changes here
                numUnifies++;
                t0.unifyWith = t1;
                // detect late unifications
                // if (currIteration > 2) error(a, `unify ${t2s(t0)} ${t2s(t1)}`)
            }
        }
        function isAssignable(fromT, toT) {
            // TODO: handle assignablity beyond interfaces and classes, e.g. "any", generics, arrays, ...
            const t0 = canonicalize(fromT);
            const t1 = canonicalize(toT);
            if (t0 === t1)
                return true;
            const c0 = typeCtor(t0);
            const c1 = typeCtor(t1);
            if (c0 === c1)
                return true;
            if (c0 && c1) {
                if (isSymbol(c0) && isSymbol(c1)) {
                    // check extends relationship (e.g. for interfaces & classes)
                    if (c0.extendsTypes && c0.extendsTypes.length) {
                        if (c0.extendsTypes.some(e => e === c1.qName)) {
                            return true;
                        }
                    }
                }
                // check unions
                if (isUnionType(t1)) {
                    for (let uT of t1.typeArgs || []) {
                        if (isAssignable(t0, uT))
                            return true;
                    }
                    return false;
                }
            }
            return false;
        }
        function narrow(e, constrainingType) {
            const t0 = canonicalize(typeOf(e));
            const t1 = canonicalize(constrainingType);
            if (isAssignable(t0, t1)) {
                return;
            }
            // if we don't know if two types are assignable, we can try to unify them in common cases
            // TODO: unification is too strict but should always be sound
            if (isFunType(t0) || isFunType(t1)
                || isPrimativeType(t0) || isPrimativeType(t1)) {
                unify(e, t0, t1);
            }
            else {
                // if we're not sure about assinability or unification, we do nothing as future
                // iterations may unify or make assinability clear.
                // TODO: Ideally what we should do is track a "constraining type" similiar to how we track .union
                // per type, and ensure the constraints are met as we unify or narrow types. The difficulty is that
                // this depends on a more accurate assignability check which will take some work to get right.
            }
        }
        function isSymbol(c) {
            var _a;
            return !!((_a = c) === null || _a === void 0 ? void 0 : _a.name);
        }
        function isGenericType(t) {
            var _a;
            return !!((_a = t === null || t === void 0 ? void 0 : t.primType) === null || _a === void 0 ? void 0 : _a.startsWith("'"));
        }
        function mkSymbol(kind, qname) {
            let m = /(.*)\.(.*)/.exec(qname);
            let name = m ? m[2] : qname;
            let ns = m ? m[1] : "";
            return {
                kind: kind,
                name: name,
                pyName: name,
                qName: qname,
                pyQName: qname,
                namespace: ns,
                attributes: {},
                pyRetType: mkType()
            };
        }
        function addSymbol(kind, qname) {
            let sym = internalApis[qname];
            if (sym) {
                sym.kind = kind;
                return sym;
            }
            sym = mkSymbol(kind, qname);
            if (!sym.pyQName)
                error(null, 9527, pxt.U.lf("Symbol '{0}' is missing pyQName", qname));
            internalApis[sym.pyQName] = sym;
            return sym;
        }
        function isLocalScope(scope) {
            let s = scope;
            while (s) {
                if (s.kind == "FunctionDef")
                    return true;
                s = s.parent;
            }
            return false;
        }
        function addSymbolFor(k, n, scope) {
            if (!n.symInfo) {
                let qn = getFullName(n);
                if (pxt.U.endsWith(qn, ".__init__"))
                    qn = qn.slice(0, -9) + ".__constructor";
                scope = scope || currentScope();
                if (isLocalScope(scope))
                    n.symInfo = mkSymbol(k, qn);
                else
                    n.symInfo = addSymbol(k, qn);
                const sym = n.symInfo;
                sym.pyAST = n;
                if (!sym.pyName)
                    error(null, 9528, pxt.U.lf("Symbol '{0}' is missing pyName", sym.qName || sym.name));
                scope.vars[sym.pyName] = {
                    symbol: sym
                };
            }
            return n.symInfo;
        }
        // TODO optimize ?
        function listClassFields(cd) {
            let qn = cd.symInfo.qName;
            return pxt.U.values(internalApis).filter(e => e.namespace == qn && e.kind == 2 /* Property */);
        }
        function getClassField(ct, n, isStatic, checkOnly = false, skipBases = false) {
            let qid;
            if (n === "__init__") {
                qid = ct.pyQName + ".__constructor";
            }
            else {
                if (n.startsWith(ct.pyQName + ".")) {
                    qid = n;
                }
                else {
                    qid = ct.pyQName + "." + n;
                }
            }
            let f = lookupGlobalSymbol(qid);
            if (f)
                return f;
            if (!skipBases) {
                for (let b of ct.extendsTypes || []) {
                    let sym = lookupGlobalSymbol(b);
                    if (sym) {
                        if (sym == ct)
                            pxt.U.userError("field lookup loop on: " + sym.qName + " / " + n);
                        let classF = getClassField(sym, n, isStatic, true);
                        if (classF)
                            return classF;
                    }
                }
            }
            if (!checkOnly && ct.pyAST && ct.pyAST.kind == "ClassDef") {
                let sym = addSymbol(2 /* Property */, qid);
                sym.isInstance = !isStatic;
                return sym;
            }
            return null;
        }
        function getTypesForFieldLookup(recvType) {
            let t = canonicalize(recvType);
            return [
                t.classType,
                ...resolvePrimTypes(t.primType),
                t.moduleType
            ].filter(isTruthy);
        }
        function getTypeField(recv, n, checkOnly = false) {
            const recvType = typeOf(recv);
            const constructorTypes = getTypesForFieldLookup(recvType);
            for (let ct of constructorTypes) {
                let isModule = !!recvType.moduleType;
                let f = getClassField(ct, n, isModule, checkOnly);
                if (f) {
                    if (isModule) {
                        if (f.isInstance)
                            error(null, 9505, pxt.U.lf("the field '{0}' of '{1}' is not static", n, ct.pyQName));
                    }
                    else {
                        if (isSuper(recv))
                            f.isProtected = true;
                        else if (isThis(recv)) {
                            if (!ctx.currClass)
                                error(null, 9529, pxt.U.lf("no class context found for {0}", f.pyQName));
                            if (f.namespace != ctx.currClass.symInfo.qName) {
                                f.isProtected = true;
                            }
                        }
                    }
                    return f;
                }
            }
            return null;
        }
        function resolvePrimTypes(primType) {
            let res = [];
            if (primType == "@array") {
                res = [lookupApi("_py.Array"), lookupApi("Array")];
            }
            else if (primType == "string") {
                // we need to check both the special "_py" namespace and the typescript "String"
                // class because for example ".length" is only defined in the latter
                res = [lookupApi("_py.String"), lookupApi("String")];
            }
            return res.filter(a => !!a);
        }
        function lookupVar(n) {
            let s = currentScope();
            let v = pxt.U.lookup(s.vars, n);
            if (v)
                return v;
            while (s) {
                let v = pxt.U.lookup(s.vars, n);
                if (v)
                    return v;
                // go to parent, excluding class scopes
                do {
                    s = s.parent;
                } while (s && s.kind == "ClassDef");
            }
            //if (autoImport && lookupGlobalSymbol(n)) {
            //    return addImport(currentScope(), n, ctx.currModule)
            //}
            return null;
        }
        function lookupScopeSymbol(n) {
            if (!n)
                return null;
            const firstDot = n.indexOf(".");
            if (firstDot > 0) {
                const scopeVar = lookupVar(n.slice(0, firstDot));
                const v = scopeVar === null || scopeVar === void 0 ? void 0 : scopeVar.symbol;
                // expand name if needed
                if (v && v.pyQName != v.pyName)
                    n = v.pyQName + n.slice(firstDot);
            }
            else {
                const v = lookupVar(n);
                if (v)
                    return v;
            }
            let globalSym = lookupGlobalSymbol(n);
            if (!globalSym)
                return undefined;
            return {
                symbol: globalSym
            };
        }
        function lookupSymbol(n) {
            var _a;
            return (_a = lookupScopeSymbol(n)) === null || _a === void 0 ? void 0 : _a.symbol;
        }
        function getClassDef(e) {
            let n = getName(e);
            let s = lookupSymbol(n);
            if (s && s.pyAST && s.pyAST.kind == "ClassDef")
                return s.pyAST;
            return null;
        }
        function typeOf(e) {
            if (e.tsType) {
                return canonicalize(e.tsType);
            }
            else {
                e.tsType = mkType();
                return e.tsType;
            }
        }
        function isOfType(e, name) {
            let t = typeOf(e);
            if (t.classType && t.classType.pyQName == name)
                return true;
            if (t2s(t) == name)
                return true;
            return false;
        }
        function resetCtx(m) {
            ctx = {
                currClass: undefined,
                currFun: undefined,
                currModule: m,
                blockDepth: 0
            };
            lastFile = m.tsFilename.replace(/\.ts$/, ".py");
        }
        function isModule(s) {
            if (!s)
                return false;
            switch (s.kind) {
                case 5 /* Module */:
                case 9 /* Interface */:
                case 8 /* Class */:
                case 6 /* Enum */:
                    return true;
                default:
                    return false;
            }
        }
        function scope(f) {
            const prevCtx = pxt.U.flatClone(ctx);
            let r;
            try {
                r = f();
            }
            finally {
                ctx = prevCtx;
            }
            return r;
        }
        function todoExpr(name, e) {
            if (!e)
                return B.mkText("");
            return B.mkGroup([B.mkText("/* TODO: " + name + " "), e, B.mkText(" */")]);
        }
        function todoComment(name, n) {
            if (n.length == 0)
                return B.mkText("");
            return B.mkGroup([B.mkText("/* TODO: " + name + " "), B.mkGroup(n), B.mkText(" */"), B.mkNewLine()]);
        }
        function doKeyword(k) {
            let t = expr(k.value);
            if (k.arg)
                return B.mkInfix(B.mkText(k.arg), "=", t);
            else
                return B.mkGroup([B.mkText("**"), t]);
        }
        function compileType(e) {
            if (!e)
                return mkType();
            let tpName = tryGetName(e);
            if (tpName) {
                let sym = lookupApi(tpName + "@type") || lookupApi(tpName);
                if (sym) {
                    getOrSetSymbolType(sym);
                    if (sym.kind == 6 /* Enum */)
                        return tpNumber;
                    if (sym.pyInstanceType)
                        return sym.pyInstanceType;
                }
                else if (builtInTypes[tpName])
                    return builtInTypes[tpName];
                error(e, 9506, pxt.U.lf("cannot find type '{0}'", tpName));
            }
            else {
                // translate Python to TS type annotation for arrays
                // example: List[str] => string[]
                if (py_1.isSubscript(e) /*i.e. [] syntax*/) {
                    let isList = tryGetName(e.value) === "List";
                    if (isList) {
                        if (py_1.isIndex(e.slice)) {
                            let listTypeArg = compileType(e.slice.value);
                            let listType = mkArrayType(listTypeArg);
                            return listType;
                        }
                    }
                }
            }
            error(e, 9507, pxt.U.lf("invalid type syntax"));
            return mkType({});
        }
        function doArgs(n, isMethod) {
            var _a;
            const args = n.args;
            if (args.kwonlyargs.length)
                error(n, 9517, pxt.U.lf("keyword-only arguments not supported yet"));
            let nargs = args.args.slice();
            if (isMethod) {
                if (((_a = nargs[0]) === null || _a === void 0 ? void 0 : _a.arg) !== "self")
                    n.symInfo.isStatic = true;
                else {
                    nargs.shift();
                }
            }
            else {
                if (nargs.some(a => a.arg == "self"))
                    error(n, 9519, pxt.U.lf("non-methods cannot have an argument called 'self'"));
            }
            if (!n.symInfo.parameters) {
                let didx = args.defaults.length - nargs.length;
                n.symInfo.parameters = nargs.map(a => {
                    if (!a.annotation)
                        error(n, 9519, pxt.U.lf("Arg '{0}' missing annotation", a.arg));
                    let tp = compileType(a.annotation);
                    let defl = "";
                    if (didx >= 0) {
                        defl = B.flattenNode([expr(args.defaults[didx])]).output;
                        unify(a, tp, typeOf(args.defaults[didx]));
                    }
                    didx++;
                    return {
                        name: a.arg,
                        description: "",
                        type: "",
                        initializer: defl,
                        default: defl,
                        pyType: tp
                    };
                });
            }
            let lst = n.symInfo.parameters.map(p => {
                let scopeV = defvar(p.name, { isParam: true });
                let v = scopeV === null || scopeV === void 0 ? void 0 : scopeV.symbol;
                if (!p.pyType)
                    error(n, 9530, pxt.U.lf("parameter '{0}' missing pyType", p.name));
                unify(n, getOrSetSymbolType(v), p.pyType);
                let res = [quote(p.name), typeAnnot(p.pyType, true)];
                if (p.default) {
                    res.push(B.mkText(" = " + p.default));
                }
                return B.mkGroup(res);
            });
            if (args.vararg)
                lst.push(B.mkText("TODO *" + args.vararg.arg));
            if (args.kwarg)
                lst.push(B.mkText("TODO **" + args.kwarg.arg));
            return B.H.mkParenthesizedExpression(B.mkCommaSep(lst));
        }
        function accessAnnot(f) {
            if (!f.pyName || f.pyName[0] != "_")
                return B.mkText("");
            return f.isProtected ? B.mkText("protected ") : B.mkText("private ");
        }
        const numOps = {
            Sub: 1,
            Div: 1,
            Pow: 1,
            LShift: 1,
            RShift: 1,
            BitOr: 1,
            BitXor: 1,
            BitAnd: 1,
            FloorDiv: 1,
            Mult: 1, // this can be also used on strings and arrays, but let's ignore that for now
        };
        const arithmeticCompareOps = {
            Eq: 1,
            NotEq: 1,
            Lt: 1,
            LtE: 1,
            Gt: 1,
            GtE: 1
        };
        const opMapping = {
            Add: "+",
            Sub: "-",
            Mult: "*",
            MatMult: "Math.matrixMult",
            Div: "/",
            Mod: "%",
            Pow: "**",
            LShift: "<<",
            RShift: ">>",
            BitOr: "|",
            BitXor: "^",
            BitAnd: "&",
            FloorDiv: "Math.idiv",
            And: "&&",
            Or: "||",
            Eq: "==",
            NotEq: "!=",
            Lt: "<",
            LtE: "<=",
            Gt: ">",
            GtE: ">=",
            Is: "===",
            IsNot: "!==",
            In: "py.In",
            NotIn: "py.NotIn",
        };
        const prefixOps = {
            Invert: "~",
            Not: "!",
            UAdd: "P+",
            USub: "P-",
        };
        const typeMap = {
            "adafruit_bus_device.i2c_device.I2CDevice": "pins.I2CDevice"
        };
        function stmts(ss) {
            ctx.blockDepth++;
            const res = B.mkBlock(ss.map(stmt));
            ctx.blockDepth--;
            return res;
        }
        function exprs0(ee) {
            ee = ee.filter(e => !!e);
            return ee.map(expr);
        }
        function setupScope(n) {
            if (!n.vars) {
                n.vars = {};
                n.parent = currentScope();
                n.blockDepth = ctx.blockDepth;
            }
        }
        function typeAnnot(t, defaultToAny = false) {
            let s = t2s(t);
            if (s === "any") {
                // TODO:
                // example from minecraft doc snippet:
                // player.onChat("while",function(num1){while(num1<10){}})
                // -> py -> ts ->
                // player.onChat("while",function(num1:any;/**TODO:type**/){while(num1<10){;}})
                // work around using any:
                // return B.mkText(": any /** TODO: type **/")
                // but for now we can just omit the type and most of the type it'll be inferable
                return defaultToAny ? B.mkText(": any") : B.mkText("");
            }
            return B.mkText(": " + t2s(t));
        }
        function guardedScope(v, f) {
            try {
                return scope(f);
            }
            catch (e) {
                console.log(e);
                return B.mkStmt(todoComment(`conversion failed for ${v.name || v.kind}`, []));
            }
        }
        function shouldInlineFunction(si) {
            if (!si || !si.pyAST)
                return false;
            if (si.pyAST.kind != "FunctionDef")
                return false;
            const fn = si.pyAST;
            if (!fn.callers || fn.callers.length != 1)
                return false;
            if (fn.callers[0].inCalledPosition)
                return false;
            return true;
        }
        function emitFunctionDef(n, inline = false) {
            return guardedScope(n, () => {
                var _a, _b, _c, _d;
                const isMethod = !!ctx.currClass && !ctx.currFun;
                const topLev = isTopLevel();
                const nested = !!ctx.currFun;
                setupScope(n);
                const existing = lookupSymbol(getFullName(n));
                const sym = addSymbolFor(isMethod ? 1 /* Method */ : 3 /* Function */, n);
                if (!inline) {
                    if (existing && existing.declared === currIteration) {
                        error(n, 9520, lf("Duplicate function declaration"));
                    }
                    sym.declared = currIteration;
                    if (shouldInlineFunction(sym)) {
                        return B.mkText("");
                    }
                }
                if (isMethod)
                    sym.isInstance = true;
                ctx.currFun = n;
                let prefix = "";
                let funname = n.name;
                const remainingDecorators = n.decorator_list.filter(d => {
                    if (tryGetName(d) == "property") {
                        prefix = "get";
                        return false;
                    }
                    if (d.kind == "Attribute" && d.attr == "setter" &&
                        d.value.kind == "Name") {
                        funname = d.value.id;
                        prefix = "set";
                        return false;
                    }
                    return true;
                });
                let nodes = [
                    todoComment("decorators", remainingDecorators.map(expr))
                ];
                if (n.body.length >= 1 && n.body[0].kind == "Raise")
                    n.alwaysThrows = true;
                if (isMethod) {
                    if (!ctx.currClass)
                        error(n, 9531, lf("method '{0}' is missing current class context", sym.pyQName));
                    if (!sym.pyRetType)
                        error(n, 9532, lf("method '{0}' is missing a return type", sym.pyQName));
                    if (n.name == "__init__") {
                        nodes.push(B.mkText("constructor"));
                        unifyClass(n, sym.pyRetType, ctx.currClass.symInfo);
                    }
                    else {
                        if (funname == "__get__" || funname == "__set__") {
                            let scopeValueVar = n.vars["value"];
                            let valueVar = scopeValueVar === null || scopeValueVar === void 0 ? void 0 : scopeValueVar.symbol;
                            if (funname == "__set__" && valueVar) {
                                let cf = getClassField(ctx.currClass.symInfo, "__get__", false);
                                if (cf && cf.pyAST && cf.pyAST.kind == "FunctionDef")
                                    unify(n, valueVar.pyRetType, cf.pyRetType);
                            }
                            funname = funname.replace(/_/g, "");
                        }
                        if (!prefix) {
                            prefix = funname[0] == "_" ? (sym.isProtected ? "protected" : "private") : "public";
                            if (n.symInfo.isStatic) {
                                prefix += " static";
                            }
                        }
                        nodes.push(B.mkText(prefix + " "), quote(funname));
                    }
                }
                else {
                    pxt.U.assert(!prefix);
                    if (n.name[0] == "_" || topLev || inline || nested)
                        nodes.push(B.mkText("function "), quote(funname));
                    else
                        nodes.push(B.mkText("export function "), quote(funname));
                }
                let retType = n.name == "__init__" ? undefined : (n.returns ? compileType(n.returns) : sym.pyRetType);
                nodes.push(doArgs(n, isMethod), retType && canonicalize(retType) != tpVoid ? typeAnnot(retType) : B.mkText(""));
                // make sure type is initialized
                getOrSetSymbolType(sym);
                let body = n.body.map(stmt);
                if (n.name == "__init__") {
                    if (!ctx.currClass)
                        error(n, 9533, lf("__init__ method '{0}' is missing current class context", sym.pyQName));
                    if ((_a = ctx.currClass) === null || _a === void 0 ? void 0 : _a.baseClass) {
                        const firstStatement = n.body[0];
                        const superConstructor = ctx.currClass.baseClass.pyQName + ".__constructor";
                        if (((_d = (_c = (_b = firstStatement.value) === null || _b === void 0 ? void 0 : _b.func) === null || _c === void 0 ? void 0 : _c.symbolInfo) === null || _d === void 0 ? void 0 : _d.pyQName) !== superConstructor) {
                            error(n, 9575, lf("Sub classes must call 'super().__init__' as the first statement inside an __init__ method"));
                        }
                    }
                    for (let f of listClassFields(ctx.currClass)) {
                        let p = f.pyAST;
                        if (p && p.value) {
                            body.push(B.mkStmt(B.mkText(`this.${quoteStr(f.pyName)} = `), expr(p.value)));
                        }
                    }
                }
                const hoisted = collectHoistedDeclarations(n);
                nodes.push(B.mkBlock(hoisted.concat(body)));
                let ret = B.mkGroup(nodes);
                if (inline)
                    nodes[nodes.length - 1].noFinalNewline = true;
                else
                    ret = B.mkStmt(ret);
                return ret;
            });
        }
        const stmtMap = {
            FunctionDef: (n) => emitFunctionDef(n),
            ClassDef: (n) => guardedScope(n, () => {
                setupScope(n);
                const sym = addSymbolFor(8 /* Class */, n);
                pxt.U.assert(!ctx.currClass);
                let topLev = isTopLevel();
                ctx.currClass = n;
                n.isNamespace = n.decorator_list.some(d => d.kind == "Name" && d.id == "namespace");
                let nodes = n.isNamespace ?
                    [B.mkText("namespace "), quote(n.name)]
                    : [
                        todoComment("keywords", n.keywords.map(doKeyword)),
                        todoComment("decorators", n.decorator_list.map(expr)),
                        B.mkText(topLev ? "class " : "export class "),
                        quote(n.name)
                    ];
                if (!n.isNamespace && n.bases.length > 0) {
                    if (tryGetName(n.bases[0]) == "Enum") {
                        n.isEnum = true;
                    }
                    else {
                        nodes.push(B.mkText(" extends "));
                        nodes.push(B.mkCommaSep(n.bases.map(expr)));
                        let b = getClassDef(n.bases[0]);
                        if (b) {
                            n.baseClass = b.symInfo;
                            sym.extendsTypes = [b.symInfo.pyQName];
                        }
                        else {
                            const nm = tryGetName(n.bases[0]);
                            if (nm) {
                                const localSym = lookupSymbol(nm);
                                const globalSym = lookupGlobalSymbol(nm);
                                n.baseClass = localSym || globalSym;
                                if (n.baseClass)
                                    sym.extendsTypes = [n.baseClass.pyQName];
                            }
                        }
                    }
                }
                const classDefs = n.body.filter(s => n.isNamespace || s.kind === "FunctionDef");
                const staticStmts = n.isNamespace ? [] : n.body.filter(s => classDefs.indexOf(s) === -1 && s.kind !== "Pass");
                let body = stmts(classDefs);
                nodes.push(body);
                // Python classes allow arbitrary statements in their bodies, sort of like namespaces.
                // Take all of these statements and put them in a static method that we can call when
                // the class is defined.
                let generatedInitFunction = false;
                if (staticStmts.length) {
                    generatedInitFunction = true;
                    const staticBody = stmts(staticStmts);
                    const initFun = B.mkStmt(B.mkGroup([
                        B.mkText(`public static __init${n.name}() `),
                        staticBody
                    ]));
                    body.children.unshift(initFun);
                }
                if (!n.isNamespace) {
                    const fieldDefs = listClassFields(n)
                        .map(f => {
                        if (!f.pyName || !f.pyRetType)
                            error(n, 9535, lf("field definition missing py name or return type", f.qName));
                        return f;
                    });
                    const staticFieldSymbols = fieldDefs.filter(f => !f.isInstance);
                    const instanceFields = fieldDefs.filter(f => f.isInstance)
                        .map((f) => B.mkStmt(accessAnnot(f), quote(f.pyName), typeAnnot(f.pyRetType)));
                    const staticFields = staticFieldSymbols
                        .map((f) => B.mkGroup([
                        B.mkStmt(accessAnnot(f), B.mkText("static "), quote(f.pyName), typeAnnot(f.pyRetType)),
                        declareLocalStatic(quoteStr(n.name), quoteStr(f.pyName), t2s(f.pyRetType))
                    ]));
                    body.children = staticFields.concat(instanceFields).concat(body.children);
                }
                if (generatedInitFunction) {
                    nodes = [
                        B.mkStmt(B.mkGroup(nodes)),
                        B.mkStmt(B.mkText(`${n.name}.__init${n.name}()`))
                    ];
                }
                return B.mkStmt(B.mkGroup(nodes));
            }),
            Return: (n) => {
                if (n.value) {
                    let f = ctx.currFun;
                    if (f) {
                        if (!f.symInfo.pyRetType)
                            error(n, 9536, lf("function '{0}' missing return type", f.symInfo.pyQName));
                        unifyTypeOf(n.value, f.symInfo.pyRetType);
                    }
                    return B.mkStmt(B.mkText("return "), expr(n.value));
                }
                else {
                    return B.mkStmt(B.mkText("return"));
                }
            },
            AugAssign: (n) => {
                let op = opMapping[n.op];
                if (op.length > 3)
                    return B.mkStmt(B.mkInfix(expr(n.target), "=", B.H.mkCall(op, [expr(n.target), expr(n.value)])));
                else
                    return B.mkStmt(expr(n.target), B.mkText(" " + op + "= "), expr(n.value));
            },
            Assign: (n) => {
                return convertAssign(n);
            },
            AnnAssign: (n) => {
                return convertAssign(n);
            },
            For: (n) => {
                pxt.U.assert(n.orelse.length == 0);
                n.target.forTargetEndPos = n.endPos;
                if (isCallTo(n.iter, "range")) {
                    let r = n.iter;
                    let def = expr(n.target);
                    let ref = quote(getName(n.target));
                    unifyTypeOf(n.target, tpNumber);
                    let start = r.args.length == 1 ? B.mkText("0") : expr(r.args[0]);
                    let stop = expr(r.args[r.args.length == 1 ? 0 : 1]);
                    if (r.args.length <= 2) {
                        return B.mkStmt(B.mkText("for ("), B.mkInfix(def, "=", start), B.mkText("; "), B.mkInfix(ref, "<", stop), B.mkText("; "), B.mkPostfix([ref], "++"), B.mkText(")"), stmts(n.body));
                    }
                    // If there are three range arguments, the comparator we need to use
                    // will either be > or < depending on the sign of the third argument.
                    let numValue = r.args[2].kind === "Num" ? r.args[2].n : undefined;
                    if (numValue == undefined && r.args[2].kind === "UnaryOp") {
                        const uOp = r.args[2];
                        if (uOp.operand.kind === "Num") {
                            if (uOp.op === "UAdd")
                                numValue = uOp.operand.n;
                            else if (uOp.op === "USub")
                                numValue = -uOp.operand.n;
                        }
                    }
                    // If the third argument is not a number, we can't know the sign so we
                    // have to emit a for-of loop instead
                    if (numValue !== undefined) {
                        const comparator = numValue > 0 ? "<" : ">";
                        return B.mkStmt(B.mkText("for ("), B.mkInfix(def, "=", start), B.mkText("; "), B.mkInfix(ref, comparator, stop), B.mkText("; "), B.mkInfix(ref, "+=", expr(r.args[2])), B.mkText(")"), stmts(n.body));
                    }
                }
                if (currIteration > 1) {
                    const typeOfTarget = typeOf(n.target);
                    /**
                     * The type the variable to iterate over must be `string | Iterable<typeof Target>`,
                     * but we can't model that with the current state of the python type checker.
                     * If we can identify the type of the value we're iterating over to be a string elsewhere,
                     * try and allow this by unifying with just the target type;
                     * otherwise, it is assumed to be an array.
                     */
                    unifyTypeOf(n.iter, typeOf(n.iter) == tpString ? typeOfTarget : mkArrayType(typeOfTarget));
                }
                return B.mkStmt(B.mkText("for ("), expr(n.target), B.mkText(" of "), expr(n.iter), B.mkText(")"), stmts(n.body));
            },
            While: (n) => {
                pxt.U.assert(n.orelse.length == 0);
                return B.mkStmt(B.mkText("while ("), expr(n.test), B.mkText(")"), stmts(n.body));
            },
            If: (n) => {
                let innerIf = (n) => {
                    let nodes = [
                        B.mkText("if ("),
                        expr(n.test),
                        B.mkText(")"),
                        stmts(n.body)
                    ];
                    if (n.orelse.length) {
                        nodes[nodes.length - 1].noFinalNewline = true;
                        if (n.orelse.length == 1 && n.orelse[0].kind == "If") {
                            // else if
                            nodes.push(B.mkText(" else "));
                            pxt.U.pushRange(nodes, innerIf(n.orelse[0]));
                        }
                        else {
                            nodes.push(B.mkText(" else"), stmts(n.orelse));
                        }
                    }
                    return nodes;
                };
                return B.mkStmt(B.mkGroup(innerIf(n)));
            },
            With: (n) => {
                if (n.items.length == 1 && isOfType(n.items[0].context_expr, "pins.I2CDevice")) {
                    let it = n.items[0];
                    let res = [];
                    let devRef = expr(it.context_expr);
                    if (it.optional_vars) {
                        let id = tryGetName(it.optional_vars);
                        if (id) {
                            let scopeV = defvar(id, { isLocal: true });
                            let v = scopeV === null || scopeV === void 0 ? void 0 : scopeV.symbol;
                            id = quoteStr(id);
                            res.push(B.mkStmt(B.mkText("const " + id + " = "), devRef));
                            if (!v.pyRetType)
                                error(n, 9537, lf("function '{0}' missing return type", v.pyQName));
                            unifyTypeOf(it.context_expr, v.pyRetType);
                            devRef = B.mkText(id);
                        }
                    }
                    res.push(B.mkStmt(B.mkInfix(devRef, ".", B.mkText("begin()"))));
                    pxt.U.pushRange(res, n.body.map(stmt));
                    res.push(B.mkStmt(B.mkInfix(devRef, ".", B.mkText("end()"))));
                    return B.mkGroup(res);
                }
                let cleanup = [];
                let stmts = n.items.map((it, idx) => {
                    let varName = "with" + idx;
                    if (it.optional_vars) {
                        let id = getName(it.optional_vars);
                        defvar(id, { isLocal: true });
                        varName = quoteStr(id);
                    }
                    cleanup.push(B.mkStmt(B.mkText(varName + ".end()")));
                    return B.mkStmt(B.mkText("const " + varName + " = "), B.mkInfix(expr(it.context_expr), ".", B.mkText("begin()")));
                });
                pxt.U.pushRange(stmts, n.body.map(stmt));
                pxt.U.pushRange(stmts, cleanup);
                return B.mkBlock(stmts);
            },
            Raise: (n) => {
                let ex = n.exc || n.cause;
                if (!ex)
                    return B.mkStmt(B.mkText("throw"));
                let msg = undefined;
                if (ex && ex.kind == "Call") {
                    let cex = ex;
                    if (cex.args.length == 1) {
                        msg = expr(cex.args[0]);
                    }
                }
                // didn't find string - just compile and quote; and hope for the best
                if (!msg)
                    msg = B.mkGroup([B.mkText("`"), expr(ex), B.mkText("`")]);
                return B.mkStmt(B.H.mkCall("control.fail", [msg]));
            },
            Assert: (n) => {
                if (!n.msg)
                    error(n, 9537, lf("assert missing message"));
                return B.mkStmt(B.H.mkCall("control.assert", exprs0([n.test, n.msg])));
            },
            Import: (n) => {
                for (let nm of n.names) {
                    if (nm.asname)
                        defvar(nm.asname, {
                            expandsTo: nm.name
                        });
                    addImport(n, nm.name);
                }
                return B.mkText("");
            },
            ImportFrom: (n) => {
                let res = [];
                for (let nn of n.names) {
                    if (nn.name == "*") {
                        if (!n.module)
                            error(n, 9538, lf("import missing module name"));
                        defvar(n.module, {
                            isImportStar: true
                        });
                    }
                    else {
                        let fullname = n.module + "." + nn.name;
                        let sym = lookupGlobalSymbol(fullname);
                        let currname = nn.asname || nn.name;
                        if (isModule(sym)) {
                            defvar(currname, {
                                isImport: sym,
                                expandsTo: fullname
                            });
                            res.push(B.mkStmt(B.mkText(`import ${quoteStr(currname)} = ${fullname}`)));
                        }
                        else {
                            defvar(currname, {
                                expandsTo: fullname
                            });
                        }
                    }
                }
                return B.mkGroup(res);
            },
            ExprStmt: (n) => n.value.kind == "Str" ?
                docComment(n.value.s) :
                B.mkStmt(expr(n.value)),
            Pass: (n) => B.mkStmt(B.mkText("")),
            Break: (n) => B.mkStmt(B.mkText("break")),
            Continue: (n) => B.mkStmt(B.mkText("continue")),
            Delete: (n) => {
                error(n, 9550, pxt.U.lf("delete statements are unsupported"));
                return stmtTODO(n);
            },
            Try: (n) => {
                let r = [
                    B.mkText("try"),
                    stmts(n.body.concat(n.orelse)),
                ];
                for (let e of n.handlers) {
                    r.push(B.mkText("catch ("), e.name ? quote(e.name) : B.mkText("_"));
                    // This isn't JS syntax, but PXT doesn't support try at all anyway
                    if (e.type)
                        r.push(B.mkText("/* instanceof "), expr(e.type), B.mkText(" */"));
                    r.push(B.mkText(")"), stmts(e.body));
                }
                if (n.finalbody.length)
                    r.push(B.mkText("finally"), stmts(n.finalbody));
                return B.mkStmt(B.mkGroup(r));
            },
            AsyncFunctionDef: (n) => {
                error(n, 9551, pxt.U.lf("async function definitions are unsupported"));
                return stmtTODO(n);
            },
            AsyncFor: (n) => {
                error(n, 9552, pxt.U.lf("async for statements are unsupported"));
                return stmtTODO(n);
            },
            AsyncWith: (n) => {
                error(n, 9553, pxt.U.lf("async with statements are unsupported"));
                return stmtTODO(n);
            },
            Global: (n) => {
                const globalScope = topScope();
                const current = currentScope();
                for (const name of n.names) {
                    const existing = pxt.U.lookup(globalScope.vars, name);
                    if (!existing) {
                        error(n, 9521, pxt.U.lf("No binding found for global variable"));
                    }
                    const sym = defvar(name, {}, py_1.VarModifier.Global);
                    if (sym.firstRefPos < n.startPos) {
                        error(n, 9522, pxt.U.lf("Variable referenced before global declaration"));
                    }
                }
                return B.mkStmt(B.mkText(""));
            },
            Nonlocal: (n) => {
                const globalScope = topScope();
                const current = currentScope();
                for (const name of n.names) {
                    const declaringScope = findNonlocalDeclaration(name, current);
                    // Python nonlocal variables cannot refer to globals
                    if (!declaringScope || declaringScope === globalScope || declaringScope.vars[name].modifier === py_1.VarModifier.Global) {
                        error(n, 9523, pxt.U.lf("No binding found for nonlocal variable"));
                    }
                    const sym = defvar(name, {}, py_1.VarModifier.NonLocal);
                    if (sym.firstRefPos < n.startPos) {
                        error(n, 9524, pxt.U.lf("Variable referenced before nonlocal declaration"));
                    }
                }
                return B.mkStmt(B.mkText(""));
            }
        };
        function convertAssign(n) {
            let annotation;
            let annotAsType;
            let value;
            let target;
            // TODO handle more than 1 target
            if (n.kind === "Assign") {
                if (n.targets.length != 1) {
                    error(n, 9553, pxt.U.lf("multi-target assignment statements are unsupported"));
                    return stmtTODO(n);
                }
                target = n.targets[0];
                value = n.value;
                annotation = null;
                annotAsType = null;
            }
            else if (n.kind === "AnnAssign") {
                target = n.target;
                value = n.value || null;
                annotation = n.annotation;
                annotAsType = compileType(annotation);
                // process annotated type, unify with target
                unifyTypeOf(target, annotAsType);
            }
            else {
                return n;
            }
            let pref = "";
            let isConstCall = value ? isCallTo(value, "const") : false;
            let nm = tryGetName(target) || "";
            if (!isTopLevel() && !ctx.currClass && !ctx.currFun && nm[0] != "_")
                pref = "export ";
            if (nm && ctx.currClass && !ctx.currFun) {
                // class fields can't be const
                // hack: value in @namespace should always be const
                isConstCall = !!(value && ctx.currClass.isNamespace);
                let fd = getClassField(ctx.currClass.symInfo, nm, true);
                if (!fd)
                    error(n, 9544, lf("cannot get class field"));
                // TODO: use or remove this code
                /*
                let src = expr(value)
                let attrTp = typeOf(value)
                let getter = getTypeField(value, "__get__", true)
                if (getter) {
                    unify(n, fd.pyRetType, getter.pyRetType)
                    let implNm = "_" + nm
                    let fdBack = getClassField(ctx.currClass.symInfo, implNm)
                    unify(n, fdBack.pyRetType, attrTp)
                    let setter = getTypeField(attrTp, "__set__", true)
                    let res = [
                        B.mkNewLine(),
                        B.mkStmt(B.mkText("private "), quote(implNm), typeAnnot(attrTp))
                    ]
                    if (!getter.fundef.alwaysThrows)
                        res.push(B.mkStmt(B.mkText(`get ${quoteStr(nm)}()`), typeAnnot(fd.type), B.mkBlock([
                            B.mkText(`return this.${quoteStr(implNm)}.get(this.i2c_device)`),
                            B.mkNewLine()
                        ])))
                    if (!setter.fundef.alwaysThrows)
                        res.push(B.mkStmt(B.mkText(`set ${quoteStr(nm)}(value`), typeAnnot(fd.type),
                            B.mkText(`) `), B.mkBlock([
                                B.mkText(`this.${quoteStr(implNm)}.set(this.i2c_device, value)`),
                                B.mkNewLine()
                            ])))
                    fdBack.initializer = value
                    fd.isGetSet = true
                    fdBack.isGetSet = true
                    return B.mkGroup(res)
                } else
                */
                if (currIteration == 0) {
                    return B.mkText("/* skip for now */");
                }
                if (!fd.pyRetType)
                    error(n, 9539, lf("function '{0}' missing return type", fd.pyQName));
                unifyTypeOf(target, fd.pyRetType);
                fd.isInstance = false;
                if (ctx.currClass.isNamespace) {
                    pref = `export ${isConstCall ? "const" : "let"} `;
                }
            }
            if (value)
                unifyTypeOf(target, typeOf(value));
            else {
                error(n, 9555, pxt.U.lf("unable to determine value of assignment"));
                return stmtTODO(n);
            }
            if (isConstCall) {
                // first run would have "let" in it
                defvar(getName(target), {});
                if (!/^static /.test(pref) && !/const/.test(pref))
                    pref += "const ";
                return B.mkStmt(B.mkText(pref), B.mkInfix(expr(target), "=", expr(value)));
            }
            if (!pref && target.kind == "Tuple") {
                let tup = target;
                let targs = [B.mkText("let "), B.mkText("[")];
                let nonNames = tup.elts.filter(e => e.kind !== "Name");
                if (nonNames.length) {
                    error(n, 9556, pxt.U.lf("non-trivial tuple assignment unsupported"));
                    return stmtTODO(n);
                }
                let tupNames = tup.elts
                    .map(e => e)
                    .map(convertName);
                targs.push(B.mkCommaSep(tupNames));
                targs.push(B.mkText("]"));
                let res = B.mkStmt(B.mkInfix(B.mkGroup(targs), "=", expr(value)));
                return res;
            }
            if (target.kind === "Name") {
                const scopeSym = currentScope().vars[nm];
                const sym = scopeSym === null || scopeSym === void 0 ? void 0 : scopeSym.symbol;
                // Mark the assignment only if the variable is declared in this scope
                if (sym && sym.kind === 4 /* Variable */ && scopeSym.modifier === undefined) {
                    if (scopeSym.firstAssignPos === undefined
                        || scopeSym.firstAssignPos > target.startPos) {
                        scopeSym.firstAssignPos = target.startPos;
                        scopeSym.firstAssignDepth = ctx.blockDepth;
                    }
                }
            }
            let lExp = undefined;
            if (annotation && annotAsType) {
                // if we have a type annotation, emit it in these cases if the r-value is:
                //  - null / undefined
                //  - empty list
                if (value.kind === "NameConstant" && value.value === null
                    || value.kind === "List" && value.elts.length === 0) {
                    const annotStr = t2s(annotAsType);
                    lExp = B.mkInfix(expr(target), ":", B.mkText(annotStr));
                }
            }
            if (!lExp)
                lExp = expr(target);
            return B.mkStmt(B.mkText(pref), B.mkInfix(lExp, "=", expr(value)));
            function convertName(n) {
                // TODO resuse with Name expr
                markInfoNode(n, "identifierCompletion");
                typeOf(n);
                let v = lookupName(n);
                return possibleDef(n, /*excludeLet*/ true);
            }
        }
        function possibleDef(n, excludeLet = false) {
            var _a, _b;
            let id = n.id;
            let currScopeVar = lookupScopeSymbol(id);
            let curr = currScopeVar === null || currScopeVar === void 0 ? void 0 : currScopeVar.symbol;
            let localScopeVar = currentScope().vars[id];
            let local = localScopeVar === null || localScopeVar === void 0 ? void 0 : localScopeVar.symbol;
            if (n.isdef === undefined) {
                if (!curr || (curr.kind === 4 /* Variable */ && curr !== local)) {
                    if (ctx.currClass && !ctx.currFun) {
                        n.isdef = false; // field
                        currScopeVar = defvar(id, {});
                    }
                    else {
                        n.isdef = true;
                        currScopeVar = defvar(id, { isLocal: true });
                    }
                    curr = currScopeVar.symbol;
                }
                else {
                    n.isdef = false;
                }
                n.symbolInfo = curr;
                if (!n.tsType)
                    error(n, 9540, lf("definition missing ts type"));
                if (!curr.pyRetType)
                    error(n, 9568, lf("missing py return type"));
                unify(n, n.tsType, curr.pyRetType);
            }
            if (n.isdef && shouldHoist(currScopeVar, currentScope())) {
                n.isdef = false;
            }
            markUsage(currScopeVar, n);
            if (n.isdef && !excludeLet) {
                return B.mkGroup([B.mkText("let "), quote(id)]);
            }
            else if ((curr === null || curr === void 0 ? void 0 : curr.namespace) && (curr === null || curr === void 0 ? void 0 : curr.qName) && !(((_a = ctx.currClass) === null || _a === void 0 ? void 0 : _a.isNamespace) && ((_b = ctx.currClass) === null || _b === void 0 ? void 0 : _b.name) === (curr === null || curr === void 0 ? void 0 : curr.namespace))) {
                // If this is a static variable in a class, we want the full qname
                return quote(curr.qName);
            }
            else
                return quote(id);
        }
        function quoteStr(id) {
            if (B.isReservedWord(id))
                return id + "_";
            else if (!id)
                return id;
            else
                return id;
            //return id.replace(/([a-z0-9])_([a-zA-Z0-9])/g, (f: string, x: string, y: string) => x + y.toUpperCase())
        }
        function tryGetName(e) {
            var _a;
            if (e.kind == "Name") {
                let s = e.id;
                let scopeV = lookupVar(s);
                let v = scopeV === null || scopeV === void 0 ? void 0 : scopeV.symbol;
                if (v) {
                    if (v.expandsTo)
                        return v.expandsTo;
                    else if (ctx.currClass && !ctx.currFun && !(scopeV === null || scopeV === void 0 ? void 0 : scopeV.modifier) && v.qName)
                        return v.qName;
                }
                return s;
            }
            if (e.kind == "Attribute") {
                let pref = tryGetName(e.value);
                if (pref)
                    return pref + "." + e.attr;
            }
            if (isSuper(e) && ((_a = ctx.currClass) === null || _a === void 0 ? void 0 : _a.baseClass)) {
                return ctx.currClass.baseClass.qName;
            }
            return undefined;
        }
        function getName(e) {
            let name = tryGetName(e);
            if (!name)
                error(null, 9542, lf("Cannot get name of unknown expression kind '{0}'", e.kind));
            return name;
        }
        function quote(id) {
            if (id == "self")
                return B.mkText("this");
            return B.mkText(quoteStr(id));
        }
        function isCallTo(n, fn) {
            if (n.kind != "Call")
                return false;
            let c = n;
            return tryGetName(c.func) === fn;
        }
        function binop(left, pyName, right) {
            let op = opMapping[pyName];
            pxt.U.assert(!!op);
            if (op.length > 3)
                return B.H.mkCall(op, [left, right]);
            else
                return B.mkInfix(left, op, right);
        }
        const funMapExtension = {
            "memoryview": { n: "", t: tpBuffer },
            "const": { n: "", t: tpNumber },
            "micropython.const": { n: "", t: tpNumber }
        };
        function getPy2TsFunMap() {
            let funMap = {};
            Object.keys(pxtc.ts2PyFunNameMap).forEach(k => {
                let tsOverride = pxtc.ts2PyFunNameMap[k];
                if (tsOverride && tsOverride.n) {
                    let py2TsOverride = {
                        n: k,
                        t: ts2PyType(tsOverride.t),
                        scale: tsOverride.scale
                    };
                    funMap[tsOverride.n] = py2TsOverride;
                }
            });
            Object.keys(funMapExtension).forEach(k => {
                funMap[k] = funMapExtension[k];
            });
            return funMap;
        }
        const py2TsFunMap = getPy2TsFunMap();
        function isSuper(v) {
            return isCallTo(v, "super") && v.args.length == 0;
        }
        function isThis(v) {
            return v.kind == "Name" && v.id == "self";
        }
        function handleFmt(n) {
            if (n.op == "Mod" && n.left.kind == "Str" &&
                (n.right.kind == "Tuple" || n.right.kind == "List")) {
                let fmt = n.left.s;
                let elts = n.right.elts;
                elts = elts.slice();
                let res = [B.mkText("`")];
                fmt.replace(/([^%]+)|(%[\d\.]*([a-zA-Z%]))/g, (f, reg, f2, flet) => {
                    if (reg)
                        res.push(B.mkText(reg.replace(/[`\\$]/g, f => "\\" + f)));
                    else {
                        let ee = elts.shift();
                        let et = ee ? expr(ee) : B.mkText("???");
                        res.push(B.mkText("${"), et, B.mkText("}"));
                    }
                    return "";
                });
                res.push(B.mkText("`"));
                return B.mkGroup(res);
            }
            return null;
        }
        function forceBackticks(n) {
            if (n.type == B.NT.Prefix && n.op[0] == "\"") {
                return B.mkText(B.backtickLit(JSON.parse(n.op)));
            }
            return n;
        }
        function nodeInInfoRange(n) {
            return syntaxInfo && n.startPos <= syntaxInfo.position && syntaxInfo.position <= n.endPos;
        }
        function markInfoNode(n, tp) {
            if (currIteration > 100 && syntaxInfo &&
                infoNode == null && (syntaxInfo.type == tp || syntaxInfo.type == "symbol") &&
                nodeInInfoRange(n)) {
                infoNode = n;
                infoScope = currentScope();
            }
        }
        function addCaller(e, v) {
            if (v && v.pyAST && v.pyAST.kind == "FunctionDef") {
                let fn = v.pyAST;
                if (!fn.callers)
                    fn.callers = [];
                if (fn.callers.indexOf(e) < 0)
                    fn.callers.push(e);
            }
        }
        const exprMap = {
            BoolOp: (n) => {
                let r = expr(n.values[0]);
                for (let i = 1; i < n.values.length; ++i) {
                    r = binop(r, n.op, expr(n.values[i]));
                }
                return r;
            },
            BinOp: (n) => {
                let r = handleFmt(n);
                if (r)
                    return r;
                const left = expr(n.left);
                const right = expr(n.right);
                if (isArrayType(n.left) && isArrayType(n.right)) {
                    if (n.op === "Add") {
                        return B.H.extensionCall("concat", [left, right], false);
                    }
                }
                r = binop(left, n.op, right);
                if (numOps[n.op]) {
                    unifyTypeOf(n.left, tpNumber);
                    unifyTypeOf(n.right, tpNumber);
                    if (!n.tsType)
                        error(n, 9570, lf("binary op missing ts type"));
                    unify(n, n.tsType, tpNumber);
                }
                return r;
            },
            UnaryOp: (n) => {
                let op = prefixOps[n.op];
                pxt.U.assert(!!op);
                return B.mkInfix(null, op, expr(n.operand));
            },
            Lambda: (n) => {
                error(n, 9574, pxt.U.lf("lambda expressions are not supported yet"));
                return exprTODO(n);
            },
            IfExp: (n) => B.mkInfix(B.mkInfix(expr(n.test), "?", expr(n.body)), ":", expr(n.orelse)),
            Dict: (n) => {
                ctx.blockDepth++;
                const elts = n.keys.map((k, i) => {
                    const v = n.values[i];
                    if (k === undefined)
                        return exprTODO(n);
                    return B.mkStmt(B.mkInfix(expr(k), ":", expr(v)), B.mkText(","));
                });
                const res = B.mkBlock(elts);
                ctx.blockDepth--;
                return res;
            },
            Set: (n) => exprTODO(n),
            ListComp: (n) => exprTODO(n),
            SetComp: (n) => exprTODO(n),
            DictComp: (n) => exprTODO(n),
            GeneratorExp: (n) => {
                if (n.generators.length == 1 && n.generators[0].kind == "Comprehension") {
                    let comp = n.generators[0];
                    if (comp.ifs.length == 0) {
                        return scope(() => {
                            let v = getName(comp.target);
                            defvar(v, { isParam: true }); // TODO this leaks the scope...
                            return B.mkInfix(expr(comp.iter), ".", B.H.mkCall("map", [
                                B.mkGroup([quote(v), B.mkText(" => "), expr(n.elt)])
                            ]));
                        });
                    }
                }
                return exprTODO(n);
            },
            Await: (n) => exprTODO(n),
            Yield: (n) => exprTODO(n),
            YieldFrom: (n) => exprTODO(n),
            Compare: (n) => {
                if (n.ops.length == 1 && (n.ops[0] == "In" || n.ops[0] == "NotIn")) {
                    if (canonicalize(typeOf(n.comparators[0])) == tpString)
                        unifyTypeOf(n.left, tpString);
                    let idx = B.mkInfix(expr(n.comparators[0]), ".", B.H.mkCall("indexOf", [expr(n.left)]));
                    return B.mkInfix(idx, n.ops[0] == "In" ? ">=" : "<", B.mkText("0"));
                }
                let left = expr(n.left);
                let right = expr(n.comparators[0]);
                // Special handling for comparisons of literal types, e.g. 0 === 5
                const castIfLiteralComparison = (op, leftExpr, rightExpr) => {
                    if (arithmeticCompareOps[op]) {
                        if (isNumStringOrBool(leftExpr) && isNumStringOrBool(rightExpr) && B.flattenNode([left]) !== B.flattenNode([right])) {
                            left = B.H.mkParenthesizedExpression(B.mkGroup([left, B.mkText(" as any")]));
                            right = B.H.mkParenthesizedExpression(B.mkGroup([right, B.mkText(" as any")]));
                        }
                    }
                };
                castIfLiteralComparison(n.ops[0], n.left, n.comparators[0]);
                let r = binop(left, n.ops[0], right);
                for (let i = 1; i < n.ops.length; ++i) {
                    left = expr(n.comparators[i - 1]);
                    right = expr(n.comparators[i]);
                    castIfLiteralComparison(n.ops[i], n.comparators[i - 1], n.comparators[i]);
                    r = binop(r, "And", binop(left, n.ops[i], right));
                }
                return r;
            },
            Call: (n) => {
                var _a, _b, _c, _d, _e;
                // TODO(dz): move body out; needs seperate PR that doesn't touch content
                n.func.inCalledPosition = true;
                let nm = tryGetName(n.func);
                let namedSymbol = lookupSymbol(nm);
                let isClass = namedSymbol && namedSymbol.kind == 8 /* Class */;
                let fun = namedSymbol;
                let recvTp = undefined;
                let recv = undefined;
                let methName = "";
                if (isClass) {
                    fun = lookupSymbol(namedSymbol.pyQName + ".__constructor");
                    if (!fun) {
                        fun = addSymbolFor(3 /* Function */, createDummyConstructorSymbol(namedSymbol === null || namedSymbol === void 0 ? void 0 : namedSymbol.pyAST));
                    }
                }
                else {
                    if (n.func.kind == "Attribute") {
                        let attr = n.func;
                        recv = attr.value;
                        recvTp = typeOf(recv);
                        if (recvTp.classType || recvTp.primType) {
                            methName = attr.attr;
                            fun = getTypeField(recv, methName, true);
                            if (fun)
                                methName = fun.name;
                        }
                    }
                }
                let orderedArgs = n.args.slice();
                if (nm == "super" && orderedArgs.length == 0) {
                    if (ctx.currClass && ctx.currClass.baseClass) {
                        if (!n.tsType)
                            error(n, 9543, lf("call expr missing ts type"));
                        unifyClass(n, n.tsType, ctx.currClass.baseClass);
                    }
                    return B.mkText("super");
                }
                if (isCallTo(n, "int") && orderedArgs.length === 1 && orderedArgs[0]) {
                    // int() compiles to either Math.trunc or parseInt depending on how it's used. Our builtin
                    // function mapping doesn't handle this well so we special case that here.
                    // TODO: consider generalizing this approach.
                    const arg = orderedArgs[0];
                    const argN = expr(arg);
                    const argT = typeOf(arg);
                    if (argT.primType === "string") {
                        return B.mkGroup([
                            B.mkText(`parseInt`),
                            B.mkText("("),
                            argN,
                            B.mkText(")")
                        ]);
                    }
                    else if (argT.primType === "number") {
                        return B.mkGroup([
                            B.mkInfix(B.mkText(`Math`), ".", B.mkText(`trunc`)),
                            B.mkText("("),
                            argN,
                            B.mkText(")")
                        ]);
                    }
                }
                if (!fun) {
                    let over = pxt.U.lookup(py2TsFunMap, nm);
                    if (over)
                        methName = "";
                    if (methName) {
                        nm = t2s(recvTp) + "." + methName;
                        over = pxt.U.lookup(py2TsFunMap, nm);
                        if (!over && typeCtor(canonicalize(recvTp)) == "@array") {
                            nm = "Array." + methName;
                            over = pxt.U.lookup(py2TsFunMap, nm);
                        }
                    }
                    methName = "";
                    if (over) {
                        if (over.n[0] == "." && orderedArgs.length) {
                            recv = orderedArgs.shift();
                            recvTp = typeOf(recv);
                            methName = over.n.slice(1);
                            fun = getTypeField(recv, methName);
                            if (fun && fun.kind == 2 /* Property */)
                                return B.mkInfix(expr(recv), ".", B.mkText(methName));
                        }
                        else {
                            fun = lookupGlobalSymbol(over.n);
                        }
                    }
                }
                if (isCallTo(n, "str")) {
                    // Our standard method of toString in TypeScript is to concatenate with the empty string
                    unify(n, n.tsType, tpString);
                    return B.mkInfix(B.mkText(`""`), "+", expr(n.args[0]));
                }
                const isSuperAttribute = n.func.kind === "Attribute" && isSuper(n.func.value);
                if (!fun && isSuperAttribute) {
                    fun = lookupGlobalSymbol(nm);
                }
                const isSuperConstructor = ((_a = ctx.currFun) === null || _a === void 0 ? void 0 : _a.name) === "__init__" &&
                    (fun === null || fun === void 0 ? void 0 : fun.name) === "__constructor" &&
                    ((_c = (_b = ctx.currClass) === null || _b === void 0 ? void 0 : _b.baseClass) === null || _c === void 0 ? void 0 : _c.pyQName) === (fun === null || fun === void 0 ? void 0 : fun.namespace) &&
                    isSuperAttribute;
                if (isSuperConstructor) {
                    fun = lookupSymbol(((_e = (_d = ctx.currClass) === null || _d === void 0 ? void 0 : _d.baseClass) === null || _e === void 0 ? void 0 : _e.pyQName) + ".__constructor");
                }
                if (!fun) {
                    error(n, 9508, pxt.U.lf("can't find called function '{0}'", nm));
                }
                let formals = fun ? fun.parameters : null;
                let allargs = [];
                if (!formals) {
                    if (fun)
                        error(n, 9509, pxt.U.lf("calling non-function"));
                    allargs = orderedArgs.map(expr);
                }
                else {
                    if (orderedArgs.length > formals.length)
                        error(n, 9510, pxt.U.lf("too many arguments in call to '{0}'", fun.pyQName));
                    while (orderedArgs.length < formals.length)
                        orderedArgs.push(null);
                    orderedArgs = orderedArgs.slice(0, formals.length);
                    for (let kw of n.keywords) {
                        let idx = formals.findIndex(f => f.name == kw.arg);
                        if (idx < 0)
                            error(kw, 9511, pxt.U.lf("'{0}' doesn't have argument named '{1}'", fun.pyQName, kw.arg));
                        else if (orderedArgs[idx] != null)
                            error(kw, 9512, pxt.U.lf("argument '{0} already specified in call to '{1}'", kw.arg, fun.pyQName));
                        else
                            orderedArgs[idx] = kw.value;
                    }
                    // skip optional args or args with initializers
                    for (let i = orderedArgs.length - 1; i >= 0; i--) {
                        if (!!formals[i].initializer && orderedArgs[i] == null)
                            orderedArgs.pop();
                        else
                            break;
                    }
                    for (let i = 0; i < orderedArgs.length; ++i) {
                        let arg = orderedArgs[i];
                        if (arg == null && !formals[i].initializer) {
                            error(n, 9513, pxt.U.lf("missing argument '{0}' in call to '{1}'", formals[i].name, fun.pyQName));
                            allargs.push(B.mkText("null"));
                        }
                        else if (arg) {
                            if (!formals[i].pyType)
                                error(n, 9545, lf("formal arg missing py type"));
                            const expectedType = formals[i].pyType;
                            if (expectedType.primType !== "any") {
                                narrow(arg, expectedType);
                            }
                            if (arg.kind == "Name" && shouldInlineFunction(arg.symbolInfo)) {
                                allargs.push(emitFunctionDef(arg.symbolInfo.pyAST, true));
                            }
                            else {
                                allargs.push(expr(arg));
                            }
                        }
                        else {
                            if (!formals[i].initializer)
                                error(n, 9547, lf("formal arg missing initializer"));
                            allargs.push(B.mkText(formals[i].initializer));
                        }
                    }
                }
                if (!infoNode && syntaxInfo && syntaxInfo.type == "signature" && nodeInInfoRange(n)) {
                    infoNode = n;
                    infoScope = currentScope();
                    syntaxInfo.auxResult = 0;
                    // foo, bar
                    for (let i = 0; i < orderedArgs.length; ++i) {
                        syntaxInfo.auxResult = i;
                        let arg = orderedArgs[i];
                        if (!arg) {
                            // if we can't parse this next argument, but the cursor is beyond the
                            // previous arguments, assume it's here
                            break;
                        }
                        if (arg.startPos <= syntaxInfo.position && syntaxInfo.position <= arg.endPos) {
                            break;
                        }
                    }
                }
                if (fun) {
                    if (!fun.pyRetType)
                        error(n, 9549, lf("function missing pyRetType"));
                    if (recv && isArrayType(recv) && recvTp) {
                        unifyArrayType(n, fun, recvTp);
                    }
                    else {
                        unifyTypeOf(n, fun.pyRetType);
                    }
                    n.symbolInfo = fun;
                    if (fun.attributes.py2tsOverride) {
                        const override = parseTypeScriptOverride(fun.attributes.py2tsOverride);
                        if (override) {
                            if (methName && !recv)
                                error(n, 9550, lf("missing recv"));
                            let res = buildOverride(override, allargs, methName ? expr(recv) : undefined);
                            if (!res)
                                error(n, 9555, lf("buildOverride failed unexpectedly"));
                            return res;
                        }
                    }
                    else if (fun.attributes.pyHelper) {
                        return B.mkGroup([
                            B.mkInfix(B.mkText("_py"), ".", B.mkText(fun.attributes.pyHelper)),
                            B.mkText("("),
                            B.mkCommaSep(recv ? [expr(recv)].concat(allargs) : allargs),
                            B.mkText(")")
                        ]);
                    }
                }
                let fn;
                if (isSuperConstructor) {
                    fn = B.mkText("super");
                }
                else {
                    fn = methName ? B.mkInfix(expr(recv), ".", B.mkText(methName)) : expr(n.func);
                }
                let nodes = [
                    fn,
                    B.mkText("("),
                    B.mkCommaSep(allargs),
                    B.mkText(")")
                ];
                if (fun && allargs.length == 1 && pxtc.service.isTaggedTemplate(fun))
                    nodes = [fn, forceBackticks(allargs[0])];
                if (isClass) {
                    if (!namedSymbol || !namedSymbol.pyQName)
                        error(n, 9551, lf("missing namedSymbol or pyQName"));
                    nodes[0] = B.mkText(applyTypeMap(namedSymbol.pyQName));
                    nodes.unshift(B.mkText("new "));
                }
                return B.mkGroup(nodes);
            },
            Num: (n) => {
                if (!n.tsType)
                    error(n, 9556, lf("tsType missing"));
                unify(n, n.tsType, tpNumber);
                return B.mkText(n.ns);
            },
            Str: (n) => {
                if (!n.tsType)
                    error(n, 9557, lf("tsType missing"));
                unify(n, n.tsType, tpString);
                return B.mkText(B.stringLit(n.s));
            },
            FormattedValue: (n) => exprTODO(n),
            JoinedStr: (n) => exprTODO(n),
            Bytes: (n) => {
                return B.mkText(`hex\`${pxt.U.toHex(new Uint8Array(n.s))}\``);
            },
            NameConstant: (n) => {
                if (n.value !== null) {
                    if (!n.tsType)
                        error(n, 9558, lf("tsType missing"));
                    unify(n, n.tsType, tpBoolean);
                }
                return B.mkText(JSON.stringify(n.value));
            },
            Ellipsis: (n) => exprTODO(n),
            Constant: (n) => exprTODO(n),
            Attribute: (n) => {
                // e.g. in "foo.bar", n.value is ["foo" expression] and n.attr is "bar"
                let lhs = expr(n.value); // run it first, in case it wants to capture infoNode
                let lhsType = typeOf(n.value);
                let fieldSymbol = getTypeField(n.value, n.attr);
                let fieldName = n.attr;
                markInfoNode(n, "memberCompletion");
                if (fieldSymbol) {
                    n.symbolInfo = fieldSymbol;
                    addCaller(n, fieldSymbol);
                    if (!n.tsType || !fieldSymbol.pyRetType)
                        error(n, 9559, lf("tsType or pyRetType missing"));
                    unify(n, n.tsType, fieldSymbol.pyRetType);
                    fieldName = fieldSymbol.name;
                }
                else if (lhsType.moduleType) {
                    let sym = lookupGlobalSymbol(lhsType.moduleType.pyQName + "." + n.attr);
                    if (sym) {
                        n.symbolInfo = sym;
                        addCaller(n, sym);
                        unifyTypeOf(n, getOrSetSymbolType(sym));
                        fieldName = sym.name;
                    }
                    else
                        error(n, 9514, pxt.U.lf("module '{0}' has no attribute '{1}'", lhsType.moduleType.pyQName, n.attr));
                }
                else {
                    if (currIteration > 2) {
                        error(n, 9515, pxt.U.lf("unknown object type; cannot lookup attribute '{0}'", n.attr));
                    }
                }
                return B.mkInfix(lhs, ".", B.mkText(quoteStr(fieldName)));
            },
            Subscript: (n) => {
                if (n.slice.kind == "Index") {
                    const objType = canonicalize(typeOf(n.value));
                    if (isArrayType(n.value)) {
                        // indexing into an array
                        const eleType = objType.typeArgs[0];
                        unifyTypeOf(n, eleType);
                    }
                    else if (objType.primType === "string") {
                        // indexing into a string
                        unifyTypeOf(n, objType);
                    }
                    else if (currIteration > 2 && isFree(typeOf(n))) {
                        // indexing into an object
                        unifyTypeOf(n, tpAny);
                    }
                    let idx = n.slice.value;
                    if (currIteration > 2 && isFree(typeOf(idx))) {
                        unifyTypeOf(idx, tpNumber);
                    }
                    return B.mkGroup([
                        expr(n.value),
                        B.mkText("["),
                        expr(idx),
                        B.mkText("]"),
                    ]);
                }
                else if (n.slice.kind == "Slice") {
                    const valueType = typeOf(n.value);
                    unifyTypeOf(n, valueType);
                    let s = n.slice;
                    if (s.step) {
                        const isString = (valueType === null || valueType === void 0 ? void 0 : valueType.primType) === "string";
                        return B.H.mkCall(isString ? "_py.stringSlice" : "_py.slice", [
                            expr(n.value),
                            s.lower ? expr(s.lower) : B.mkText("null"),
                            s.upper ? expr(s.upper) : B.mkText("null"),
                            expr(s.step)
                        ]);
                    }
                    return B.mkInfix(expr(n.value), ".", B.H.mkCall("slice", [s.lower ? expr(s.lower) : B.mkText("0"),
                        s.upper ? expr(s.upper) : null].filter(isTruthy)));
                }
                else {
                    return exprTODO(n);
                }
            },
            Starred: (n) => B.mkGroup([B.mkText("... "), expr(n.value)]),
            Name: (n) => {
                markInfoNode(n, "identifierCompletion");
                // shortcut, but should work
                if (n.id == "self" && ctx.currClass) {
                    if (!n.tsType)
                        error(n, 9560, lf("missing tsType"));
                    unifyClass(n, n.tsType, ctx.currClass.symInfo);
                    return B.mkText("this");
                }
                let scopeV = lookupName(n);
                let v = scopeV === null || scopeV === void 0 ? void 0 : scopeV.symbol;
                // handle import
                if (v && v.isImport) {
                    return quote(v.name); // it's import X = Y.Z.X, use X not Y.Z.X
                }
                markUsage(scopeV, n);
                if (n.ctx.indexOf("Load") >= 0) {
                    if (!v)
                        return quote(getName(n));
                    if (!(v === null || v === void 0 ? void 0 : v.qName)) {
                        error(n, 9561, lf("missing qName"));
                        return quote("unknown");
                    }
                    // Note: We track types like String as "String@type" but when actually emitting them
                    // we want to elide the the "@type"
                    const nm = v.qName.replace("@type", "");
                    return quote(nm);
                }
                else {
                    return possibleDef(n);
                }
            },
            List: mkArrayExpr,
            Tuple: mkArrayExpr,
        };
        function lookupName(n) {
            let scopeV = lookupScopeSymbol(n.id);
            let v = scopeV === null || scopeV === void 0 ? void 0 : scopeV.symbol;
            if (!scopeV) {
                // check if the symbol has an override py<->ts mapping
                let over = pxt.U.lookup(py2TsFunMap, n.id);
                if (over) {
                    scopeV = lookupScopeSymbol(over.n);
                }
            }
            if (scopeV && v) {
                n.symbolInfo = v;
                if (!n.tsType)
                    error(n, 9562, lf("missing tsType"));
                unify(n, n.tsType, getOrSetSymbolType(v));
                if (v.isImport)
                    return scopeV;
                addCaller(n, v);
                if (n.forTargetEndPos && scopeV.forVariableEndPos !== n.forTargetEndPos) {
                    if (scopeV.forVariableEndPos)
                        // defined in more than one 'for'; make sure it's hoisted
                        scopeV.lastRefPos = scopeV.forVariableEndPos + 1;
                    else
                        scopeV.forVariableEndPos = n.forTargetEndPos;
                }
            }
            else if (currIteration > 0) {
                error(n, 9516, pxt.U.lf("name '{0}' is not defined", n.id));
            }
            return scopeV;
        }
        function markUsage(s, location) {
            if (s) {
                if (s.modifier === py_1.VarModifier.Global) {
                    const declaringScope = topScope();
                    if (declaringScope && declaringScope.vars[s.symbol.name]) {
                        s = declaringScope.vars[s.symbol.name];
                    }
                }
                else if (s.modifier === py_1.VarModifier.NonLocal) {
                    const declaringScope = findNonlocalDeclaration(s.symbol.name, currentScope());
                    if (declaringScope) {
                        s = declaringScope.vars[s.symbol.name];
                    }
                }
                if (s.firstRefPos === undefined || s.firstRefPos > location.startPos) {
                    s.firstRefPos = location.startPos;
                }
                if (s.lastRefPos === undefined || s.lastRefPos < location.startPos) {
                    s.lastRefPos = location.startPos;
                }
            }
        }
        function mkArrayExpr(n) {
            if (!n.tsType)
                error(n, 9563, lf("missing tsType"));
            unify(n, n.tsType, mkArrayType(n.elts[0] ? typeOf(n.elts[0]) : mkType()));
            return B.mkGroup([
                B.mkText("["),
                B.mkCommaSep(n.elts.map(expr)),
                B.mkText("]"),
            ]);
        }
        function sourceMapId(e) {
            return `${e.startPos}:${e.endPos}`;
        }
        function expr(e) {
            lastAST = e;
            let f = exprMap[e.kind];
            if (!f) {
                pxt.U.oops(e.kind + " - unknown expr");
            }
            typeOf(e);
            const r = f(e);
            r.id = sourceMapId(e);
            return r;
        }
        function stmt(e) {
            lastAST = e;
            let f = stmtMap[e.kind];
            if (!f) {
                pxt.U.oops(e.kind + " - unknown stmt");
            }
            let cmts = (e._comments || []).map(c => c.value);
            let r = f(e);
            if (cmts.length) {
                r = B.mkGroup(cmts.map(c => B.mkStmt(B.H.mkComment(c))).concat(r));
            }
            r.id = sourceMapId(e);
            return r;
        }
        function isEmpty(b) {
            if (!b)
                return true;
            if (b.type == B.NT.Prefix && b.op == "")
                return b.children.every(isEmpty);
            if (b.type == B.NT.NewLine)
                return true;
            return false;
        }
        function declareVariable(s) {
            const name = quote(s.name);
            const type = t2s(getOrSetSymbolType(s));
            return B.mkStmt(B.mkGroup([B.mkText("let "), name, B.mkText(": " + type + ";")]));
        }
        function findNonlocalDeclaration(name, scope) {
            if (!scope)
                return undefined;
            const symbolInfo = scope.vars && scope.vars[name];
            if (symbolInfo && symbolInfo.modifier != py_1.VarModifier.NonLocal) {
                return scope;
            }
            else {
                return findNonlocalDeclaration(name, scope.parent);
            }
        }
        function collectHoistedDeclarations(scope) {
            const hoisted = [];
            let current;
            for (const varName of Object.keys(scope.vars)) {
                current = scope.vars[varName];
                if (shouldHoist(current, scope)) {
                    hoisted.push(declareVariable(current === null || current === void 0 ? void 0 : current.symbol));
                }
            }
            return hoisted;
        }
        function shouldHoist(sym, scope) {
            let result = sym.symbol.kind === 4 /* Variable */
                && !sym.symbol.isParam
                && sym.modifier === undefined
                && (sym.lastRefPos > sym.forVariableEndPos
                    || sym.firstRefPos < sym.firstAssignPos
                    || sym.firstAssignDepth > scope.blockDepth)
                && !(isTopLevelScope(scope) && sym.firstAssignDepth === 0);
            return !!result;
        }
        function isTopLevelScope(scope) {
            return scope.kind === "Module" && scope.name === "main";
        }
        // TODO look at scopes of let
        function toTS(mod) {
            pxt.U.assert(mod.kind == "Module");
            if (mod.tsBody)
                return undefined;
            resetCtx(mod);
            if (!mod.vars)
                mod.vars = {};
            const hoisted = collectHoistedDeclarations(mod);
            let res = hoisted.concat(mod.body.map(stmt));
            if (res.every(isEmpty))
                return undefined;
            else if (mod.name == "main")
                return res;
            return [
                B.mkText("namespace " + mod.name + " "),
                B.mkBlock(res)
            ];
        }
        function iterPy(e, f) {
            if (!e)
                return;
            f(e);
            pxt.U.iterMap(e, (k, v) => {
                if (!v || k == "parent")
                    return;
                if (v && v.kind)
                    iterPy(v, f);
                else if (Array.isArray(v))
                    v.forEach((x) => iterPy(x, f));
            });
        }
        function resetPass(iter) {
            currIteration = iter;
            diagnostics = [];
            numUnifies = 0;
            lastAST = undefined;
        }
        function py2ts(opts) {
            let modules = [];
            const outfiles = {};
            diagnostics = [];
            pxt.U.assert(!!opts.sourceFiles, "missing sourceFiles! Cannot convert py to ts");
            // find .ts files that are copies of / shadowed by the .py files
            let pyFiles = opts.sourceFiles.filter(fn => pxt.U.endsWith(fn, ".py"));
            if (pyFiles.length == 0)
                return { outfiles, diagnostics, success: diagnostics.length === 0, sourceMap: [] };
            let removeEnd = (file, ext) => file.substr(0, file.length - ext.length);
            let pyFilesSet = pxt.U.toDictionary(pyFiles, p => removeEnd(p, ".py"));
            let tsFiles = opts.sourceFiles
                .filter(fn => pxt.U.endsWith(fn, ".ts"));
            let tsShadowFiles = tsFiles
                .filter(fn => removeEnd(fn, ".ts") in pyFilesSet);
            pxt.U.assert(!!opts.apisInfo, "missing apisInfo! Cannot convert py to ts");
            lastFile = pyFiles[0]; // make sure there's some location info for errors from API init
            initApis(opts.apisInfo, tsShadowFiles);
            compileOptions = opts;
            syntaxInfo = undefined;
            if (!opts.generatedFiles)
                opts.generatedFiles = [];
            for (const fn of pyFiles) {
                let sn = fn;
                let modname = fn.replace(/\.py$/, "").replace(/.*\//, "");
                let src = opts.fileSystem[fn];
                try {
                    lastFile = fn;
                    let tokens = pxt.py.lex(src);
                    //console.log(pxt.py.tokensToString(tokens))
                    let res = pxt.py.parse(src, sn, tokens);
                    //console.log(pxt.py.dump(stmts))
                    pxt.U.pushRange(diagnostics, res.diagnostics);
                    modules.push({
                        kind: "Module",
                        body: res.stmts,
                        blockDepth: 0,
                        name: modname,
                        source: src,
                        tsFilename: sn.replace(/\.py$/, ".ts")
                    });
                }
                catch (e) {
                    // TODO
                    console.log("Parse error", e);
                }
            }
            const parseDiags = diagnostics;
            for (let i = 0; i < 5; ++i) {
                resetPass(i);
                for (let m of modules) {
                    try {
                        toTS(m);
                        // console.log(`after ${currIteration} - ${numUnifies}`)
                    }
                    catch (e) {
                        console.log("Conv pass error", e);
                    }
                }
                if (numUnifies == 0)
                    break;
            }
            resetPass(1000);
            infoNode = undefined;
            syntaxInfo = opts.syntaxInfo || {
                position: 0,
                type: "symbol"
            };
            let sourceMap = [];
            for (let m of modules) {
                try {
                    let nodes = toTS(m);
                    if (!nodes)
                        continue;
                    let res = B.flattenNode(nodes);
                    opts.sourceFiles.push(m.tsFilename);
                    opts.generatedFiles.push(m.tsFilename);
                    opts.fileSystem[m.tsFilename] = res.output;
                    outfiles[m.tsFilename] = res.output;
                    let rawSrcMap = res.sourceMap;
                    function unpackInterval(i) {
                        let splits = i.id.split(":");
                        if (splits.length != 2)
                            return undefined;
                        let py = splits.map(i => parseInt(i));
                        return {
                            py: {
                                startPos: py[0],
                                endPos: py[1]
                            },
                            ts: {
                                startPos: i.startPos,
                                endPos: i.endPos
                            }
                        };
                    }
                    sourceMap = rawSrcMap
                        .map(unpackInterval)
                        .filter(i => !!i);
                }
                catch (e) {
                    console.log("Conv error", e);
                }
            }
            diagnostics = parseDiags.concat(diagnostics);
            const isGlobalSymbol = (si) => {
                switch (si.kind) {
                    case 6 /* Enum */:
                    case 7 /* EnumMember */:
                    case 4 /* Variable */:
                    case 3 /* Function */:
                    case 5 /* Module */:
                        return true;
                    case 2 /* Property */:
                    case 1 /* Method */:
                        return !si.isInstance;
                    default:
                        return false;
                }
            };
            // always return global symbols because we might need to check for
            // name collisions downstream
            let globalNames = {};
            const apis = pxt.U.values(externalApis).concat(pxt.U.values(internalApis));
            let existing = [];
            const addSym = (v) => {
                if (isGlobalSymbol(v) && existing.indexOf(v) < 0) {
                    let s = cleanSymbol(v);
                    globalNames[s.qName || s.name] = s;
                }
            };
            for (let s = infoScope; !!s; s = s.parent) {
                if (s && s.vars)
                    pxt.U.values(s.vars)
                        .map(v => v.symbol)
                        .forEach(addSym);
            }
            apis.forEach(addSym);
            if (syntaxInfo && infoNode) {
                infoNode = infoNode;
                syntaxInfo.beginPos = infoNode.startPos;
                syntaxInfo.endPos = infoNode.endPos;
                if (!syntaxInfo.symbols)
                    syntaxInfo.symbols = [];
                existing = syntaxInfo.symbols.slice();
                if (syntaxInfo.type == "memberCompletion" && infoNode.kind == "Attribute") {
                    const attr = infoNode;
                    const tp = typeOf(attr.value);
                    if (tp.moduleType) {
                        for (let v of apis) {
                            if (!v.isInstance && v.namespace == tp.moduleType.qName) {
                                syntaxInfo.symbols.push(v);
                            }
                        }
                    }
                    else if (tp.classType || tp.primType) {
                        const ct = tp.classType
                            || resolvePrimTypes(tp.primType).reduce((p, n) => p || n, null);
                        if (ct) {
                            if (!ct.extendsTypes || !ct.qName)
                                error(null, 9567, lf("missing extendsTypes or qName"));
                            let types = ct.extendsTypes.concat(ct.qName);
                            for (let v of apis) {
                                if (v.isInstance && types.indexOf(v.namespace) >= 0) {
                                    syntaxInfo.symbols.push(v);
                                }
                            }
                        }
                    }
                }
                else if (syntaxInfo.type == "identifierCompletion") {
                    syntaxInfo.symbols = pxt.U.values(globalNames);
                }
                else {
                    let sym = infoNode.symbolInfo;
                    if (sym)
                        syntaxInfo.symbols.push(sym);
                }
                syntaxInfo.symbols = syntaxInfo.symbols.map(cleanSymbol);
            }
            let outDiag = patchedDiags();
            return {
                outfiles: outfiles,
                success: outDiag.length === 0,
                diagnostics: outDiag,
                syntaxInfo,
                globalNames,
                sourceMap: sourceMap
            };
            function patchedDiags() {
                for (let d of diagnostics) {
                    py_1.patchPosition(d, opts.fileSystem[d.fileName]);
                }
                return diagnostics;
            }
        }
        py_1.py2ts = py2ts;
        /**
         * Override example syntax:
         *      indexOf()       (no arguments)
         *      indexOf($1, $0) (arguments in different order)
         *      indexOf($0?)    (optional argument)
         *      indexOf($0=0)   (default value; can be numbers, single quoted strings, false, true, null, undefined)
         */
        function parseTypeScriptOverride(src) {
            const regex = new RegExp(/([^\$]*\()?([^\$\(]*)\$(\d)(?:(?:(?:=(\d+|'[a-zA-Z0-9_]*'|false|true|null|undefined))|(\?)|))/, 'y');
            const parts = [];
            let match;
            let lastIndex = 0;
            do {
                lastIndex = regex.lastIndex;
                match = regex.exec(src);
                if (match) {
                    if (match[1]) {
                        parts.push({
                            kind: "text",
                            text: match[1]
                        });
                    }
                    parts.push({
                        kind: "arg",
                        prefix: match[2],
                        index: parseInt(match[3]),
                        default: match[4],
                        isOptional: !!match[5]
                    });
                }
            } while (match);
            if (lastIndex != undefined) {
                parts.push({
                    kind: "text",
                    text: src.substr(lastIndex)
                });
            }
            else {
                parts.push({
                    kind: "text",
                    text: src
                });
            }
            return {
                parts
            };
        }
        function isArrayType(expr) {
            const t = canonicalize(typeOf(expr));
            return t && t.primType === "@array";
        }
        function isNumStringOrBool(expr) {
            switch (expr.kind) {
                case "Num":
                case "Str":
                    return true;
                case "NameConstant":
                    return expr.value !== null;
            }
            return false;
        }
        function buildOverride(override, args, recv) {
            const result = [];
            for (const part of override.parts) {
                if (part.kind === "text") {
                    result.push(B.mkText(part.text));
                }
                else if (args[part.index] || part.default) {
                    if (part.prefix)
                        result.push(B.mkText(part.prefix));
                    if (args[part.index]) {
                        result.push(args[part.index]);
                    }
                    else {
                        result.push(B.mkText(part.default));
                    }
                }
                else if (part.isOptional) {
                    // do nothing
                }
                else {
                    return undefined;
                }
            }
            if (recv) {
                return B.mkInfix(recv, ".", B.mkGroup(result));
            }
            return B.mkGroup(result);
        }
        function unifyArrayType(e, fun, arrayType) {
            // Do our best to unify the generic types by special casing everything
            switch (fun.qName) {
                case "Array.pop":
                case "Array.removeAt":
                case "Array.shift":
                case "Array.find":
                case "Array.get":
                case "Array._pickRandom":
                    unifyTypeOf(e, arrayType.typeArgs[0]);
                    break;
                case "Array.concat":
                case "Array.slice":
                case "Array.filter":
                case "Array.fill":
                    unifyTypeOf(e, arrayType);
                    break;
                case "Array.reduce":
                    if (e.kind === "Call" && e.args.length > 1) {
                        const accumulatorType = typeOf(e.args[1]);
                        if (accumulatorType)
                            unifyTypeOf(e, accumulatorType);
                    }
                    break;
                case "Array.map":
                    // TODO: infer type properly from function instead of bailing out here
                    unifyTypeOf(e, mkArrayType(tpAny));
                    break;
                default:
                    unifyTypeOf(e, fun.pyRetType);
                    break;
            }
        }
        function createDummyConstructorSymbol(def, sym = def.symInfo) {
            var _a;
            const existing = lookupApi(sym.pyQName + ".__constructor");
            if (!existing && ((_a = sym.extendsTypes) === null || _a === void 0 ? void 0 : _a.length)) {
                const parentSymbol = lookupSymbol(sym.extendsTypes[0]) || lookupGlobalSymbol(sym.extendsTypes[0]);
                if (parentSymbol) {
                    return createDummyConstructorSymbol(def, parentSymbol);
                }
            }
            const result = {
                kind: "FunctionDef",
                name: "__init__",
                startPos: def.startPos,
                endPos: def.endPos,
                parent: def,
                body: [],
                args: {
                    kind: "Arguments",
                    startPos: 0,
                    endPos: 0,
                    args: [{
                            startPos: 0,
                            endPos: 0,
                            kind: "Arg",
                            arg: "self"
                        }],
                    kw_defaults: [],
                    kwonlyargs: [],
                    defaults: []
                },
                decorator_list: [],
                vars: {},
                symInfo: mkSymbol(3 /* Function */, def.symInfo.qName + ".__constructor")
            };
            result.symInfo.parameters = [];
            result.symInfo.pyRetType = mkType({ classType: def.symInfo });
            if (existing) {
                result.args.args.push(...existing.parameters.map(p => ({
                    startPos: 0,
                    endPos: 0,
                    kind: "Arg",
                    arg: p.name,
                })));
                result.symInfo.parameters.push(...existing.parameters.map(p => {
                    if (p.pyType)
                        return p;
                    const res = Object.assign(Object.assign({}, p), { pyType: mapTsType(p.type) });
                    return res;
                }));
            }
            return result;
        }
        function declareLocalStatic(className, name, type) {
            const isSetVar = `___${name}_is_set`;
            const localVar = `___${name}`;
            return B.mkStmt(B.mkStmt(B.mkText(`private ${isSetVar}: boolean`)), B.mkStmt(B.mkText(`private ${localVar}: ${type}`)), B.mkStmt(B.mkText(`get ${name}(): ${type}`), B.mkBlock([
                B.mkText(`return this.${isSetVar} ? this.${localVar} : ${className}.${name}`)
            ])), B.mkStmt(B.mkText(`set ${name}(value: ${type})`), B.mkBlock([
                B.mkStmt(B.mkText(`this.${isSetVar} = true`)),
                B.mkStmt(B.mkText(`this.${localVar} = value`)),
            ])));
        }
    })(py = pxt.py || (pxt.py = {}));
})(pxt || (pxt = {}));
// Lexer spec: https://docs.python.org/3/reference/lexical_analysis.html
var pxt;
(function (pxt) {
    var py;
    (function (py) {
        let TokenType;
        (function (TokenType) {
            TokenType[TokenType["Id"] = 0] = "Id";
            TokenType[TokenType["Op"] = 1] = "Op";
            TokenType[TokenType["Keyword"] = 2] = "Keyword";
            TokenType[TokenType["Number"] = 3] = "Number";
            TokenType[TokenType["String"] = 4] = "String";
            TokenType[TokenType["NewLine"] = 5] = "NewLine";
            TokenType[TokenType["Comment"] = 6] = "Comment";
            TokenType[TokenType["Indent"] = 7] = "Indent";
            TokenType[TokenType["Dedent"] = 8] = "Dedent";
            TokenType[TokenType["EOF"] = 9] = "EOF";
            TokenType[TokenType["Error"] = 10] = "Error";
        })(TokenType = py.TokenType || (py.TokenType = {}));
        py.keywords = {
            "False": true, "None": true, "True": true, "and": true, "as": true, "assert": true,
            "async": true, "await": true, "break": true, "class": true, "continue": true,
            "def": true, "del": true, "elif": true, "else": true, "except": true, "finally": true,
            "for": true, "from": true, "global": true, "if": true, "import": true, "in": true,
            "is": true, "lambda": true, "nonlocal": true, "not": true, "or": true, "pass": true,
            "raise": true, "return": true, "try": true, "while": true, "with": true, "yield": true,
        };
        let asciiParse = [];
        let allOps;
        let revOps;
        const eqOps = {
            "%": "Mod",
            "&": "BitAnd",
            "*": "Mult",
            "**": "Pow",
            "+": "Add",
            "-": "Sub",
            "/": "Div",
            "//": "FloorDiv",
            "<<": "LShift",
            ">>": "RShift",
            "@": "MatMult",
            "^": "BitXor",
            "|": "BitOr",
        };
        const nonEqOps = {
            "!": "Bang",
            "!=": "NotEq",
            "(": "LParen",
            ")": "RParen",
            ",": "Comma",
            "->": "Arrow",
            ".": "Dot",
            ":": "Colon",
            ";": "Semicolon",
            "<": "Lt",
            "<=": "LtE",
            "=": "Assign",
            "==": "Eq",
            ">": "Gt",
            ">=": "GtE",
            "[": "LSquare",
            "]": "RSquare",
            "{": "LBracket",
            "}": "RBracket",
            "~": "Invert",
        };
        const numBases = {
            "b": /^[_0-1]$/,
            "B": /^[_0-1]$/,
            "o": /^[_0-7]$/,
            "O": /^[_0-7]$/,
            "x": /^[_0-9a-fA-F]$/,
            "X": /^[_0-9a-fA-F]$/,
        };
        const numBasesRadix = {
            "b": 2,
            "B": 2,
            "o": 8,
            "O": 8,
            "x": 16,
            "X": 16,
        };
        // resettable lexer state
        let res;
        let source;
        let pos = 0, pos0 = 0;
        function position(startPos, source) {
            let lineno = 0;
            let lastnl = 0;
            for (let i = 0; i < startPos; ++i) {
                if (source.charCodeAt(i) == 10) {
                    lineno++;
                    lastnl = i;
                }
            }
            return { line: lineno, column: startPos - lastnl - 1 };
        }
        py.position = position;
        function patchPosition(d, src) {
            if (!d.start && !d.length) {
                d.start = 0;
                d.length = 0;
                d.line = 0;
                d.column = 0;
                return;
            }
            let p = position(d.start, src);
            d.line = p.line;
            d.column = p.column;
            if (d.length > 0) {
                p = position(d.start + d.length - 1, src);
                d.endLine = p.line;
                d.endColumn = p.column + 2; // not sure where the +2 is coming from, but it works out in monaco
            }
        }
        py.patchPosition = patchPosition;
        function tokenToString(t) {
            switch (t.type) {
                case TokenType.Id:
                    return `id(${t.value})`;
                case TokenType.Op:
                    return "'" + revOps[t.value] + "'";
                case TokenType.Keyword:
                    return t.value;
                case TokenType.Number:
                    return `num(${t.value})`;
                case TokenType.String:
                    return t.stringPrefix + JSON.stringify(t.value);
                case TokenType.NewLine:
                    return `<nl>`;
                case TokenType.Comment:
                    return `/* ${t.value} */`;
                case TokenType.Indent:
                    return "indent" + t.value;
                case TokenType.Dedent:
                    return "dedent";
                case TokenType.Error:
                    return `[ERR: ${t.value}]`;
                case TokenType.EOF:
                    return "End of file";
                default:
                    return "???";
            }
        }
        py.tokenToString = tokenToString;
        function friendlyTokenToString(t, source) {
            let len = t.endPos - t.startPos;
            let s = "";
            if (len == 0) {
                s = tokenToString(t);
            }
            else if (len > 20) {
                s = "`" + source.slice(t.startPos, t.startPos + 20) + "`...";
            }
            else {
                s = "`" + source.slice(t.startPos, t.endPos) + "`";
            }
            s = s.replace(/\r/g, "")
                .replace(/\n/g, "\\n")
                .replace(/\t/g, "\\t");
            return s;
        }
        py.friendlyTokenToString = friendlyTokenToString;
        function tokensToString(ts) {
            let r = "";
            let lineLen = 0;
            for (let t of ts) {
                let tmp = tokenToString(t);
                if (lineLen + tmp.length > 70) {
                    lineLen = 0;
                    r += "\n";
                }
                if (lineLen != 0)
                    r += " ";
                r += tmp;
                lineLen += tmp.length;
                if (t.type == TokenType.NewLine || t.type == TokenType.Comment) {
                    lineLen = 0;
                    r += "\n";
                }
            }
            return r;
        }
        py.tokensToString = tokensToString;
        function lex(_source) {
            if (asciiParse.length == 0)
                initAsciiParse();
            // these can't be local, since we capture lambdas from the first execution
            source = _source;
            res = [];
            pos = 0;
            pos0 = 0;
            checkIndent();
            while (pos < source.length) {
                pos0 = pos;
                const ch = source.charCodeAt(pos++);
                if (ch < 128) {
                    asciiParse[ch]();
                }
                else if (py.rx.isIdentifierStart(ch)) {
                    parseId();
                }
                else if (py.rx.isSpace(ch)) {
                    // skip
                }
                else if (py.rx.isNewline(ch)) {
                    singleNewline();
                }
                else {
                    invalidToken();
                }
            }
            pos0 = pos;
            singleNewline();
            addToken(TokenType.EOF, "");
            return res;
            function addToken(type, val, aux) {
                let t = {
                    type: type,
                    value: val,
                    startPos: pos0,
                    endPos: pos,
                    auxValue: aux
                };
                res.push(t);
                return t;
            }
            function addError(msg) {
                addToken(TokenType.Error, msg);
            }
            function parseId() {
                while (py.rx.isIdentifierChar(source.charCodeAt(pos)))
                    pos++;
                let id = source.slice(pos0, pos);
                let ch = source.charCodeAt(pos);
                if (py.keywords.hasOwnProperty(id))
                    addToken(TokenType.Keyword, id);
                else if (ch == 34 || ch == 39)
                    parseStringPref(id);
                else
                    addToken(TokenType.Id, id);
            }
            function singleOp(name) {
                addToken(TokenType.Op, name);
            }
            function multiOp(name) {
                let ch2 = source.slice(pos0, pos + 1);
                if (ch2.length == 2 && allOps.hasOwnProperty(ch2)) {
                    let ch3 = source.slice(pos0, pos + 2);
                    if (ch3.length == 3 && allOps.hasOwnProperty(ch3)) {
                        pos += 2;
                        name = allOps[ch3];
                    }
                    else {
                        pos++;
                        name = allOps[ch2];
                    }
                }
                singleOp(name);
            }
            function asciiEsc(code) {
                switch (code) {
                    case 97: return 7; // \a
                    case 98: return 8; // \b
                    case 102: return 12; // \f
                    case 110: return 10; // \n
                    case 114: return 13; // \r
                    case 116: return 9; // \t
                    case 118: return 11; // \v
                    default: return 0;
                }
            }
            function unicode(c) {
                return ("0000" + c.toString(16)).slice(-4);
            }
            function parseStringPref(pref) {
                const delim = source.charCodeAt(pos++);
                let tripleMode = false;
                if (source.charCodeAt(pos) == delim && source.charCodeAt(pos + 1) == delim) {
                    pos += 2;
                    tripleMode = true;
                }
                pref = pref.toLowerCase();
                let rawMode = pref.indexOf("r") >= 0;
                let value = "";
                let quoted = "";
                while (true) {
                    const ch = source.charCodeAt(pos++);
                    if (ch == delim) {
                        if (tripleMode) {
                            if (source.charCodeAt(pos) == delim &&
                                source.charCodeAt(pos + 1) == delim) {
                                pos += 2;
                                break;
                            }
                            else {
                                quoted += "\\" + String.fromCharCode(delim);
                                value += String.fromCharCode(delim);
                            }
                        }
                        else {
                            break;
                        }
                    }
                    else if (ch == 92) {
                        let ch2 = source.charCodeAt(pos++);
                        if (ch2 == 13 && source.charCodeAt(pos) == 10) {
                            ch2 = 10;
                            pos++;
                        }
                        if (ch2 == 34 || ch2 == 39 || ch2 == 92) {
                            if (rawMode) {
                                quoted += "\\";
                                value += "\\";
                            }
                            quoted += "\\" + String.fromCharCode(ch2);
                            value += String.fromCharCode(ch2);
                        }
                        else if (!rawMode && asciiEsc(ch2)) {
                            quoted += "\\" + String.fromCharCode(ch2);
                            value += String.fromCharCode(asciiEsc(ch2));
                        }
                        else if (py.rx.isNewline(ch2)) {
                            if (rawMode) {
                                value += "\\" + String.fromCharCode(ch2);
                                quoted += "\\\\";
                                if (ch2 == 10)
                                    quoted += "\\n";
                                else
                                    quoted += "\\u" + unicode(ch2);
                            }
                            else {
                                // skip
                            }
                        }
                        else if (!rawMode && ch2 == 48) {
                            // handle \0 as special case
                            quoted += "\\\\x00";
                            value += "\x00";
                        }
                        else if (!rawMode && (ch2 == 117 || ch2 == 120)) {
                            // We pass as is
                            // TODO add support for octal (\123)
                            let len = ch2 == 117 ? 4 : 2;
                            let num = source.slice(pos, pos + len);
                            pos += len;
                            let v = parseInt(num, 16);
                            if (isNaN(v))
                                addError(pxt.U.lf("invalid unicode or hex escape"));
                            quoted += "\\" + String.fromCharCode(ch2) + num;
                            value += String.fromCharCode(v);
                        }
                        else {
                            quoted += "\\\\" + String.fromCharCode(ch2);
                            value += "\\" + String.fromCharCode(ch2);
                        }
                    }
                    else if (isNaN(ch)) {
                        addError(pxt.U.lf("end of file in a string"));
                        break;
                    }
                    else {
                        if (py.rx.isNewline(ch)) {
                            if (!tripleMode) {
                                addError(pxt.U.lf("new line in a string"));
                                break;
                            }
                        }
                        value += String.fromCharCode(ch);
                        quoted += String.fromCharCode(ch);
                    }
                }
                let t = addToken(TokenType.String, value);
                t.quoted = quoted;
                t.stringPrefix = pref;
            }
            function parseString() {
                pos--;
                parseStringPref("");
            }
            function singleNewline() {
                addToken(TokenType.NewLine, "");
                checkIndent();
            }
            function checkIndent() {
                let ind = 0;
                while (true) {
                    const ch = source.charCodeAt(pos);
                    if (ch == 9) {
                        // addError(U.lf("TAB indentaion not supported"))
                        ind = (ind + 8) & ~7;
                        pos++;
                        continue;
                    }
                    if (ch != 32)
                        break;
                    ind++;
                    pos++;
                }
                addToken(TokenType.Indent, "" + ind);
            }
            function parseBackslash() {
                let ch2 = source.charCodeAt(pos);
                if (py.rx.isNewline(ch2)) {
                    pos++;
                    if (ch2 == 13 && source.charCodeAt(pos) == 10)
                        pos++;
                }
                else {
                    addError(pxt.U.lf("unexpected character after line continuation character"));
                }
            }
            function parseComment() {
                addToken(TokenType.NewLine, "");
                while (pos < source.length) {
                    if (py.rx.isNewline(source.charCodeAt(pos)))
                        break;
                    pos++;
                }
                addToken(TokenType.Comment, source.slice(pos0 + 1, pos));
                if (source.charCodeAt(pos) == 13 && source.charCodeAt(pos + 1) == 10)
                    pos++;
                pos++; // skip newline
                checkIndent();
            }
            function parseNumber() {
                let c1 = source[pos0];
                let num = "";
                // TypeScript supports 0x, 0o, 0b, as well as _ in numbers,
                // so we just pass them as is
                if (c1 == "0") {
                    let c2 = source[pos];
                    const rx = numBases[c2];
                    if (rx) {
                        pos++;
                        while (true) {
                            const ch = source[pos];
                            if (!rx.test(ch))
                                break;
                            num += ch;
                            pos++;
                        }
                        if (num) {
                            let p = parseInt(num, numBasesRadix[c2]);
                            if (isNaN(p))
                                addError(pxt.U.lf("invalid number"));
                            addToken(TokenType.Number, c1 + c2 + num, p);
                        }
                        else
                            addError(pxt.U.lf("expecting numbers to follow 0b, 0o, 0x"));
                        return;
                    }
                }
                // decimal, possibly float
                let seenDot = false;
                let seenE = false;
                let minusAllowed = false;
                pos = pos0;
                while (true) {
                    const ch = source.charCodeAt(pos);
                    if (minusAllowed && (ch == 43 || ch == 45)) {
                        // ok
                    }
                    else {
                        minusAllowed = false;
                        if (ch == 95 || isDigit(ch)) {
                            // OK
                        }
                        else if (!seenE && !seenDot && ch == 46) {
                            seenDot = true;
                        }
                        else if (!seenE && (ch == 69 || ch == 101)) {
                            seenE = true;
                            minusAllowed = true;
                        }
                        else {
                            break;
                        }
                    }
                    num += String.fromCharCode(ch);
                    pos++;
                }
                if (!seenDot && !seenE && c1 == "0" && num.length > 1 && !/^0+/.test(num))
                    addError(pxt.U.lf("unexpected leading zero"));
                let p = parseFloat(num);
                if (isNaN(p))
                    addError(pxt.U.lf("invalid number"));
                addToken(TokenType.Number, num, p);
            }
            function parseDot() {
                if (isDigit(source.charCodeAt(pos)))
                    parseNumber();
                else
                    addToken(TokenType.Op, "Dot");
            }
            function isDigit(ch) {
                return (48 <= ch && ch <= 57);
            }
            function invalidToken() {
                addError(pxt.U.lf("invalid token"));
            }
            function initAsciiParse() {
                const specialParse = {
                    "\"": parseString,
                    "'": parseString,
                    "#": parseComment,
                    "\\": parseBackslash,
                    ".": parseDot,
                };
                allOps = pxt.U.clone(nonEqOps);
                for (let k of Object.keys(eqOps)) {
                    allOps[k] = eqOps[k];
                    allOps[k + "="] = eqOps[k] + "Assign";
                }
                revOps = {};
                for (let k of Object.keys(allOps)) {
                    revOps[allOps[k]] = k;
                }
                for (let i = 0; i < 128; ++i) {
                    if (py.rx.isIdentifierStart(i))
                        asciiParse[i] = parseId;
                    else {
                        let s = String.fromCharCode(i);
                        if (specialParse.hasOwnProperty(s)) {
                            asciiParse[i] = specialParse[s];
                        }
                        else if (allOps.hasOwnProperty(s)) {
                            let canBeLengthened = false;
                            let op = allOps[s];
                            for (let kk of Object.keys(allOps)) {
                                if (kk != s && kk.startsWith(s)) {
                                    canBeLengthened = true;
                                }
                            }
                            if (canBeLengthened) {
                                asciiParse[i] = () => multiOp(op);
                            }
                            else {
                                asciiParse[i] = () => singleOp(op);
                            }
                        }
                        else if (py.rx.isSpace(i)) {
                            asciiParse[i] = () => { };
                        }
                        else if (i == 13) {
                            asciiParse[i] = () => {
                                if (source.charCodeAt(pos) == 10)
                                    pos++;
                                singleNewline();
                            };
                        }
                        else if (py.rx.isNewline(i)) {
                            asciiParse[i] = singleNewline;
                        }
                        else if (isDigit(i)) {
                            asciiParse[i] = parseNumber;
                        }
                        else {
                            asciiParse[i] = invalidToken;
                        }
                    }
                }
            }
        }
        py.lex = lex;
    })(py = pxt.py || (pxt.py = {}));
})(pxt || (pxt = {}));
// Grammar is here: https://docs.python.org/3/reference/grammar.html
var pxt;
(function (pxt) {
    var py;
    (function (py) {
        let inParens;
        let tokens;
        let source;
        let filename;
        let nextToken;
        let currComments;
        let indentStack;
        let prevToken;
        let diags;
        let traceParser = false;
        let traceLev = "";
        function fakeToken(tp, val) {
            return {
                type: tp,
                value: val,
                startPos: 0,
                endPos: 0
            };
        }
        function traceAST(tp, r) {
            if (traceParser) {
                pxt.log(traceLev + tp + ": " + r.kind);
            }
        }
        function peekToken() {
            return tokens[nextToken];
        }
        function skipTokens() {
            for (; tokens[nextToken]; nextToken++) {
                let t = tokens[nextToken];
                if (t.type == py.TokenType.Comment) {
                    currComments.push(t);
                    continue;
                }
                if (inParens >= 0 && t.type == py.TokenType.Op)
                    switch (t.value) {
                        case "LParen":
                        case "LSquare":
                        case "LBracket":
                            inParens++;
                            break;
                        case "RParen":
                        case "RSquare":
                        case "RBracket":
                            inParens--;
                            break;
                    }
                if (t.type == py.TokenType.Error) {
                    error(9551, t.value);
                    continue;
                }
                if (inParens > 0) {
                    if (t.type == py.TokenType.NewLine || t.type == py.TokenType.Indent)
                        continue;
                }
                else {
                    if (t.type == py.TokenType.Indent) {
                        if (tokens[nextToken + 1].type == py.TokenType.NewLine) {
                            nextToken++;
                            continue; // skip empty lines
                        }
                        let curr = parseInt(t.value);
                        let top = indentStack[indentStack.length - 1];
                        if (curr == top)
                            continue;
                        else if (curr > top) {
                            indentStack.push(curr);
                            return;
                        }
                        else {
                            t.type = py.TokenType.Dedent;
                            let numPop = 0;
                            while (indentStack.length) {
                                let top = indentStack[indentStack.length - 1];
                                if (top > curr) {
                                    indentStack.pop();
                                    numPop++;
                                }
                                else {
                                    if (top != curr)
                                        error(9552, pxt.U.lf("inconsitent indentation"));
                                    // in case there is more than one dedent, replicate current dedent token
                                    while (numPop > 1) {
                                        tokens.splice(nextToken, 0, t);
                                        numPop--;
                                    }
                                    return;
                                }
                            }
                        }
                    }
                }
                return;
            }
        }
        function shiftToken() {
            prevToken = peekToken();
            if (prevToken.type == py.TokenType.EOF)
                return;
            nextToken++;
            skipTokens();
            // console.log(`TOK: ${tokenToString(peekToken())}`)
        }
        // next error: see "next free error" in "converter.ts"
        function error(code, msg) {
            if (!msg)
                msg = pxt.U.lf("invalid syntax");
            if (!code)
                code = 9550;
            const tok = peekToken();
            const d = {
                code,
                category: pxtc.DiagnosticCategory.Error,
                messageText: pxt.U.lf("{0} near {1}", msg, py.friendlyTokenToString(tok, source)),
                fileName: filename,
                start: tok.startPos,
                length: tok.endPos ? tok.endPos - tok.startPos : 0,
                line: 0,
                column: 0
            };
            py.patchPosition(d, source);
            if (traceParser)
                pxt.log(`${traceLev}TS${code} ${d.messageText} at ${d.line + 1},${d.column + 1}`);
            diags.push(d);
            if (code != 9572 && diags.length > 100)
                pxt.U.userError(pxt.U.lf("too many parse errors"));
        }
        function expect(tp, val) {
            const t = peekToken();
            if (t.type != tp || t.value != val) {
                error(9553, pxt.U.lf("expecting {0}", py.tokenToString(fakeToken(tp, val))));
                if (t.type == py.TokenType.NewLine)
                    return; // don't shift
            }
            shiftToken();
        }
        function expectNewline() {
            expect(py.TokenType.NewLine, "");
        }
        function expectKw(kw) {
            expect(py.TokenType.Keyword, kw);
        }
        function expectOp(op) {
            expect(py.TokenType.Op, op);
        }
        function currentKw() {
            let t = peekToken();
            if (t.type == py.TokenType.Keyword)
                return t.value;
            return "";
        }
        function currentOp() {
            let t = peekToken();
            if (t.type == py.TokenType.Op)
                return t.value;
            return "";
        }
        const compound_stmt_map = {
            "if": if_stmt,
            "while": while_stmt,
            "for": for_stmt,
            "try": try_stmt,
            "with": with_stmt,
            "def": funcdef,
            "class": classdef,
        };
        const small_stmt_map = {
            "del": del_stmt,
            "pass": pass_stmt,
            "break": break_stmt,
            "continue": continue_stmt,
            "return": return_stmt,
            "raise": raise_stmt,
            "global": global_stmt,
            "nonlocal": nonlocal_stmt,
            "import": import_name,
            "from": import_from,
            "assert": assert_stmt,
            "yield": yield_stmt,
        };
        function colon_suite() {
            expectOp("Colon");
            return suite();
        }
        function suite() {
            if (peekToken().type == py.TokenType.NewLine) {
                const prevTr = traceLev;
                if (traceParser) {
                    pxt.log(traceLev + "{");
                    traceLev += "  ";
                }
                shiftToken();
                let outputRange;
                if (peekToken().type != py.TokenType.Indent) {
                    error(9554, pxt.U.lf("expected an indented block"));
                    outputRange = stmt();
                }
                else {
                    const level = parseInt(peekToken().value);
                    shiftToken();
                    outputRange = stmt();
                    for (;;) {
                        if (peekToken().type == py.TokenType.Dedent) {
                            const isFinal = (isNaN(level) || parseInt(peekToken().value) < level);
                            shiftToken();
                            if (isFinal)
                                break;
                        }
                        pxt.U.pushRange(outputRange, stmt());
                        if (peekToken().type == py.TokenType.EOF)
                            break;
                    }
                }
                if (traceParser) {
                    traceLev = prevTr;
                    pxt.log(traceLev + "}");
                }
                return outputRange;
            }
            else {
                return simple_stmt();
            }
        }
        function mkAST(kind, beg) {
            let t = beg || peekToken();
            return {
                startPos: t.startPos,
                endPos: t.endPos,
                kind
            };
        }
        function finish(v) {
            v.endPos = prevToken.endPos;
            return v;
        }
        function orelse() {
            if (currentKw() == "else") {
                shiftToken();
                return colon_suite();
            }
            return [];
        }
        function while_stmt() {
            let r = mkAST("While");
            expectKw("while");
            r.test = test();
            r.body = colon_suite();
            r.orelse = orelse();
            return finish(r);
        }
        function if_stmt() {
            let r = mkAST("If");
            shiftToken();
            r.test = test();
            r.body = colon_suite();
            if (currentKw() == "elif") {
                r.orelse = [if_stmt()];
            }
            else {
                r.orelse = orelse();
            }
            return finish(r);
        }
        function for_stmt() {
            let r = mkAST("For");
            expectKw("for");
            r.target = exprlist();
            setStoreCtx(r.target);
            expectKw("in");
            r.iter = testlist();
            r.body = colon_suite();
            r.orelse = orelse();
            return finish(r);
        }
        function try_stmt() {
            let r = mkAST("Try");
            expectKw("try");
            r.body = colon_suite();
            r.handlers = [];
            let sawDefault = false;
            for (;;) {
                if (currentKw() == "except") {
                    let eh = mkAST("ExceptHandler");
                    r.handlers.push(eh);
                    shiftToken();
                    if (currentOp() != "Colon") {
                        if (sawDefault)
                            error();
                        eh.type = test();
                        if (currentKw() == "as") {
                            shiftToken();
                            eh.name = name();
                        }
                        else {
                            eh.name = undefined;
                        }
                    }
                    else {
                        sawDefault = true;
                        eh.type = undefined;
                        eh.name = undefined;
                    }
                    eh.body = colon_suite();
                }
                else {
                    break;
                }
            }
            r.orelse = orelse();
            if (r.handlers.length == 0 && r.orelse.length)
                error();
            if (currentKw() == "finally") {
                shiftToken();
                r.finalbody = colon_suite();
            }
            else {
                r.finalbody = [];
            }
            return finish(r);
        }
        function raise_stmt() {
            let r = mkAST("Raise");
            expectKw("raise");
            r.exc = undefined;
            r.cause = undefined;
            if (!atStmtEnd()) {
                r.exc = test();
                if (currentKw() == "from") {
                    shiftToken();
                    r.cause = test();
                }
            }
            return finish(r);
        }
        function with_item() {
            let r = mkAST("WithItem");
            r.context_expr = test();
            r.optional_vars = undefined;
            if (currentKw() == "as") {
                shiftToken();
                r.optional_vars = expr();
            }
            return finish(r);
        }
        function with_stmt() {
            let r = mkAST("With");
            expectKw("with");
            r.items = parseSepList(pxt.U.lf("with item"), with_item);
            r.body = colon_suite();
            return finish(r);
        }
        function funcdef() {
            let r = mkAST("FunctionDef");
            expectKw("def");
            r.name = name();
            expectOp("LParen");
            r.args = parse_arguments(true);
            expectOp("RParen");
            r.returns = undefined;
            if (currentOp() == "Arrow") {
                shiftToken();
                r.returns = test();
            }
            r.body = colon_suite();
            return finish(r);
        }
        function classdef() {
            let r = mkAST("ClassDef");
            expectKw("class");
            r.name = name();
            if (currentOp() == "LParen") {
                let rr = parseArgs();
                r.bases = rr.args;
                r.keywords = rr.keywords;
            }
            else {
                r.bases = [];
                r.keywords = [];
            }
            r.body = colon_suite();
            return finish(r);
        }
        function del_stmt() {
            let r = mkAST("Delete");
            expectKw("del");
            r.targets = parseList(pxt.U.lf("expression"), expr);
            return finish(r);
        }
        function wrap_expr_stmt(e) {
            let r = mkAST("ExprStmt");
            r.startPos = e.startPos;
            r.endPos = e.endPos;
            r.value = e;
            return r;
        }
        function yield_stmt() {
            let t0 = peekToken();
            shiftToken();
            if (currentKw() == "from") {
                let r = mkAST("YieldFrom");
                r.value = test();
                return wrap_expr_stmt(finish(r));
            }
            let r = mkAST("Yield");
            if (!atStmtEnd())
                r.value = testlist();
            return wrap_expr_stmt(finish(r));
        }
        function pass_stmt() {
            let r = mkAST("Pass");
            expectKw("pass");
            return finish(r);
        }
        function atStmtEnd() {
            let t = peekToken();
            return t.type == py.TokenType.NewLine || (t.type == py.TokenType.Op && t.value == "Semicolon");
        }
        function break_stmt() {
            let r = mkAST("Break");
            shiftToken();
            return finish(r);
        }
        function continue_stmt() {
            let r = mkAST("Continue");
            shiftToken();
            return finish(r);
        }
        function return_stmt() {
            let r = mkAST("Return");
            shiftToken();
            if (!atStmtEnd()) {
                r.value = testlist();
            }
            else {
                r.value = undefined;
            }
            return finish(r);
        }
        function global_stmt() {
            let r = mkAST("Global");
            shiftToken();
            r.names = [];
            for (;;) {
                r.names.push(name());
                if (currentOp() == "Comma") {
                    shiftToken();
                }
                else {
                    break;
                }
            }
            return finish(r);
        }
        function nonlocal_stmt() {
            let r = global_stmt();
            r.kind = "Nonlocal";
            return r;
        }
        function dotted_name() {
            let s = "";
            for (;;) {
                s += name();
                if (currentOp() == "Dot") {
                    s += ".";
                    shiftToken();
                }
                else {
                    return s;
                }
            }
        }
        function dotted_as_name() {
            let r = mkAST("Alias");
            r.name = dotted_name();
            if (currentKw() == "as") {
                shiftToken();
                r.asname = name();
            }
            else {
                r.asname = undefined;
            }
            return finish(r);
        }
        function import_as_name() {
            let r = mkAST("Alias");
            r.name = name();
            if (currentKw() == "as") {
                shiftToken();
                r.asname = name();
            }
            else {
                r.asname = undefined;
            }
            return finish(r);
        }
        function dots() {
            let r = 0;
            for (;;) {
                if (currentOp() == "Dot") {
                    r += 1;
                    shiftToken();
                }
                else if (currentOp() == "Ellipsis") {
                    // not currently generated by lexer anyways
                    r += 3;
                    shiftToken();
                }
                else {
                    return r;
                }
            }
        }
        function import_name() {
            let r = mkAST("Import");
            shiftToken();
            r.names = parseSepList(pxt.U.lf("import name"), dotted_as_name);
            return finish(r);
        }
        function import_from() {
            let r = mkAST("ImportFrom");
            shiftToken();
            r.level = dots();
            if (peekToken().type == py.TokenType.Id)
                r.module = dotted_name();
            else
                r.module = undefined;
            if (!r.level && !r.module)
                error();
            expectKw("import");
            if (currentOp() == "Mult") {
                shiftToken();
                let star = mkAST("Alias");
                star.name = "*";
                r.names = [star];
            }
            else if (currentOp() == "LParen") {
                shiftToken();
                r.names = parseList(pxt.U.lf("import name"), import_as_name);
                expectOp("RParen");
            }
            else {
                r.names = parseList(pxt.U.lf("import name"), import_as_name);
            }
            return finish(r);
        }
        function assert_stmt() {
            let r = mkAST("Assert");
            shiftToken();
            r.test = test();
            if (currentOp() == "Comma") {
                shiftToken();
                r.msg = test();
            }
            else
                r.msg = undefined;
            return finish(r);
        }
        function tuple(t0, exprs) {
            let tupl = mkAST("Tuple", t0);
            tupl.elts = exprs;
            return finish(tupl);
        }
        function testlist_core(f) {
            let t0 = peekToken();
            let exprs = parseList(pxt.U.lf("expression"), f);
            let expr = exprs[0];
            if (exprs.length != 1)
                return tuple(t0, exprs);
            return expr;
        }
        function testlist_star_expr() { return testlist_core(star_or_test); }
        function testlist() { return testlist_core(test); }
        function exprlist() { return testlist_core(expr); }
        // somewhat approximate
        function setStoreCtx(e) {
            if (e.kind == "Tuple") {
                let t = e;
                t.elts.forEach(setStoreCtx);
            }
            else {
                e.ctx = "Store";
            }
        }
        function expr_stmt() {
            let t0 = peekToken();
            let expr = testlist_star_expr();
            let op = currentOp();
            if (op == "Assign") {
                let assign = mkAST("Assign");
                assign.targets = [expr];
                for (;;) {
                    shiftToken();
                    expr = testlist_star_expr();
                    op = currentOp();
                    if (op == "Assign") {
                        assign.targets.push(expr);
                    }
                    else {
                        assign.value = expr;
                        break;
                    }
                }
                assign.targets.forEach(setStoreCtx);
                return finish(assign);
            }
            if (op == "Colon") {
                let annAssign = mkAST("AnnAssign");
                annAssign.target = expr;
                shiftToken();
                annAssign.annotation = test();
                if (currentOp() == "Assign") {
                    shiftToken();
                    annAssign.value = test();
                }
                annAssign.simple = t0.type == py.TokenType.Id && expr.kind == "Name" ? 1 : 0;
                setStoreCtx(annAssign.target);
                return finish(annAssign);
            }
            if (pxt.U.endsWith(op, "Assign")) {
                let augAssign = mkAST("AugAssign");
                augAssign.target = expr;
                augAssign.op = op.replace("Assign", "");
                shiftToken();
                augAssign.value = testlist();
                setStoreCtx(augAssign.target);
                return finish(augAssign);
            }
            if (op == "Semicolon" || peekToken().type == py.TokenType.NewLine) {
                let exprStmt = mkAST("ExprStmt");
                exprStmt.value = expr;
                return finish(exprStmt);
            }
            error(9555, pxt.U.lf("unexpected token"));
            shiftToken();
            return null;
        }
        function small_stmt() {
            let fn = pxt.U.lookup(small_stmt_map, currentKw());
            if (fn)
                return fn();
            else
                return expr_stmt();
        }
        function simple_stmt() {
            let res = [small_stmt()];
            while (currentOp() == "Semicolon") {
                shiftToken();
                if (peekToken().type == py.TokenType.NewLine)
                    break;
                res.push(small_stmt());
            }
            expectNewline();
            return res.filter(s => !!s);
        }
        function stmt() {
            const prevErr = diags.length;
            const hasIndentationError = peekToken().type == py.TokenType.Indent;
            if (hasIndentationError) {
                shiftToken();
                error(9573, pxt.U.lf("unexpected indent"));
            }
            let decorators = [];
            while (currentOp() == "MatMult") {
                shiftToken();
                decorators.push(atom_expr());
                expectNewline();
            }
            let kw = currentKw();
            let fn = pxt.U.lookup(compound_stmt_map, currentKw());
            let rr = [];
            let comments = currComments;
            currComments = [];
            if (kw == "class" || kw == "def") {
                let r = fn();
                r.decorator_list = decorators;
                rr = [r];
            }
            else if (decorators.length) {
                error(9556, pxt.U.lf("decorators not allowed here"));
            }
            else if (fn)
                rr = [fn()];
            else
                rr = simple_stmt();
            if (comments.length && rr.length)
                rr[0]._comments = comments;
            // there were errors in this stmt; skip tokens until newline to resync
            let skp = [];
            if (diags.length > prevErr) {
                inParens = -1;
                while (prevToken.type != py.TokenType.Dedent && prevToken.type != py.TokenType.NewLine) {
                    shiftToken();
                    if (traceParser)
                        skp.push(py.tokenToString(peekToken()));
                    if (peekToken().type == py.TokenType.EOF)
                        break;
                }
                if (hasIndentationError && peekToken().type === py.TokenType.Dedent) {
                    shiftToken();
                }
                inParens = 0;
                if (traceParser)
                    pxt.log(traceLev + "skip: " + skp.join(", "));
            }
            if (traceParser)
                for (let r of rr)
                    traceAST("stmt", r);
            return rr;
        }
        function parse_arguments(allowTypes) {
            let r = mkAST("Arguments");
            r.args = [];
            r.defaults = [];
            r.kwonlyargs = [];
            r.kw_defaults = [];
            r.vararg = undefined;
            for (;;) {
                let o = currentOp();
                if (o == "Colon" || o == "RParen")
                    break;
                if (o == "Mult") {
                    if (r.vararg)
                        error(9557, pxt.U.lf("multiple *arg"));
                    shiftToken();
                    if (peekToken().type == py.TokenType.Id)
                        r.vararg = pdef();
                    else
                        r.vararg = undefined;
                }
                else if (o == "Pow") {
                    if (r.kwarg)
                        error(9558, pxt.U.lf("multiple **arg"));
                    shiftToken();
                    r.kwarg = pdef();
                }
                else {
                    if (r.kwarg)
                        error(9559, pxt.U.lf("arguments after **"));
                    let a = pdef();
                    let defl = undefined;
                    if (currentOp() == "Assign") {
                        shiftToken();
                        defl = test();
                    }
                    if (r.vararg !== undefined && defl) {
                        r.kwonlyargs.push(a);
                        r.kw_defaults.push(defl);
                    }
                    else {
                        r.args.push(a);
                        if (defl)
                            r.defaults.push(defl);
                        else if (r.defaults.length)
                            error(9560, pxt.U.lf("non-default argument follows default argument"));
                    }
                }
                if (currentOp() == "Comma") {
                    shiftToken();
                }
                else {
                    break;
                }
            }
            if (!r.kwarg)
                r.kwarg = undefined;
            if (!r.vararg)
                r.vararg = undefined;
            return finish(r);
            function pdef() {
                let r = mkAST("Arg");
                r.arg = name();
                r.annotation = undefined;
                if (allowTypes) {
                    if (currentOp() == "Colon") {
                        shiftToken();
                        r.annotation = test();
                    }
                }
                return r;
            }
        }
        function lambdef(noCond) {
            let r = mkAST("Lambda");
            shiftToken();
            r.args = parse_arguments(false);
            expectOp("Colon");
            r.body = noCond ? test_nocond() : test();
            return finish(r);
        }
        function test() {
            if (currentKw() == "lambda")
                return lambdef();
            let t0 = peekToken();
            let t = or_test();
            if (currentKw() == "if") {
                let r = mkAST("IfExp", t0);
                r.body = t;
                expectKw("if");
                r.test = or_test();
                expectKw("else");
                r.orelse = test();
                return finish(r);
            }
            return t;
        }
        function bool_test(op, f) {
            let t0 = peekToken();
            let r = f();
            if (currentKw() == op) {
                let rr = mkAST("BoolOp", t0);
                rr.op = op == "or" ? "Or" : "And";
                rr.values = [r];
                while (currentKw() == op) {
                    expectKw(op);
                    rr.values.push(f());
                }
                return finish(rr);
            }
            return r;
        }
        function and_test() {
            return bool_test("and", not_test);
        }
        function or_test() {
            return bool_test("or", and_test);
        }
        function not_test() {
            if (currentKw() == "not") {
                let r = mkAST("UnaryOp");
                shiftToken();
                r.op = "Not";
                r.operand = not_test();
                return finish(r);
            }
            else
                return comparison();
        }
        const cmpOpMap = {
            'Lt': "Lt",
            'Gt': "Gt",
            'Eq': "Eq",
            'GtE': "GtE",
            'LtE': "LtE",
            'NotEq': "NotEq",
            'in': "In",
            'not': "NotIn",
            'is': "Is",
        };
        function getCmpOp() {
            return cmpOpMap[currentOp()] || cmpOpMap[currentKw()] || null;
        }
        function comparison() {
            let t0 = peekToken();
            let e = expr();
            if (!getCmpOp())
                return e;
            let r = mkAST("Compare", t0);
            r.left = e;
            r.comparators = [];
            r.ops = [];
            while (true) {
                let c = getCmpOp();
                if (!c)
                    break;
                shiftToken();
                if (c == "NotIn")
                    expectKw("in");
                else if (c == "Is") {
                    if (currentKw() == "not") {
                        shiftToken();
                        c = "IsNot";
                    }
                }
                r.ops.push(c);
                r.comparators.push(expr());
            }
            return finish(r);
        }
        const unOpMap = {
            'Invert': "Invert",
            'Sub': "USub",
            'Add': "UAdd",
        };
        function binOp(f, ops) {
            let t0 = peekToken();
            let e = f();
            for (;;) {
                let o = currentOp();
                if (o && ops.indexOf("," + o + ",") >= 0) {
                    let r = mkAST("BinOp", t0);
                    r.left = e;
                    r.op = o;
                    shiftToken();
                    r.right = f();
                    e = r;
                }
                else {
                    return e;
                }
            }
        }
        function term() { return binOp(factor, ",Mult,MatMult,Div,Mod,FloorDiv,"); }
        function arith_expr() { return binOp(term, ",Add,Sub,"); }
        function shift_expr() { return binOp(arith_expr, ",LShift,RShift,"); }
        function and_expr() { return binOp(shift_expr, ",BitAnd,"); }
        function xor_expr() { return binOp(and_expr, ",BitXor,"); }
        function expr() { return binOp(xor_expr, ",BitOr,"); }
        function subscript() {
            let t0 = peekToken();
            let lower = undefined;
            if (currentOp() != "Colon") {
                lower = test();
            }
            if (currentOp() == "Colon") {
                let r = mkAST("Slice", t0);
                r.lower = lower;
                shiftToken();
                let o = currentOp();
                if (o != "Colon" && o != "Comma" && o != "RSquare")
                    r.upper = test();
                else
                    r.upper = undefined;
                r.step = undefined;
                if (currentOp() == "Colon") {
                    shiftToken();
                    o = currentOp();
                    if (o != "Comma" && o != "RSquare")
                        r.step = test();
                }
                return finish(r);
            }
            else {
                if (!lower)
                    error(9570, pxt.U.lf("unable to parse lower subscript"));
                let r = mkAST("Index");
                r.value = lower;
                return finish(r);
            }
        }
        function star_or_test() {
            if (currentOp() == "Mult") {
                let r = mkAST("Starred");
                r.value = expr();
                return finish(r);
            }
            else {
                return test();
            }
        }
        function test_nocond() {
            if (currentKw() == "lambda")
                return lambdef(true);
            else
                return or_test();
        }
        function comp_for() {
            let rr = [];
            for (;;) {
                let r = mkAST("Comprehension");
                r.is_async = 0;
                rr.push(r);
                expectKw("for");
                r.target = exprlist();
                setStoreCtx(r.target);
                expectKw("in");
                r.iter = or_test();
                r.ifs = [];
                for (;;) {
                    if (currentKw() == "if") {
                        shiftToken();
                        r.ifs.push(test_nocond());
                    }
                    else
                        break;
                }
                if (currentKw() != "for")
                    return rr;
            }
        }
        function argument() {
            let t0 = peekToken();
            if (currentOp() == "Mult") {
                let r = mkAST("Starred");
                shiftToken();
                r.value = test();
                return finish(r);
            }
            if (currentOp() == "Pow") {
                let r = mkAST("Keyword");
                shiftToken();
                r.arg = undefined;
                r.value = test();
                return finish(r);
            }
            let e = test();
            if (currentOp() == "Assign") {
                if (e.kind != "Name") {
                    error(9561, pxt.U.lf("invalid keyword argument; did you mean ==?"));
                }
                shiftToken();
                let r = mkAST("Keyword", t0);
                r.arg = e.id || "???";
                r.value = test();
                return finish(r);
            }
            else if (currentKw() == "for") {
                let r = mkAST("GeneratorExp", t0);
                r.elt = e;
                r.generators = comp_for();
                return finish(r);
            }
            else {
                return e;
            }
        }
        function dictorsetmaker() {
            let t0 = peekToken();
            shiftToken();
            if (currentOp() == "Pow") {
                shiftToken();
                return dict(undefined, expr());
            }
            else if (currentOp() == "RBracket") {
                let r = mkAST("Dict", t0);
                shiftToken();
                r.keys = [];
                r.values = [];
                return finish(r);
            }
            else {
                let e = star_or_test();
                if (e.kind != "Starred" && currentOp() == "Colon") {
                    shiftToken();
                    return dict(e, test());
                }
                else {
                    return set(e);
                }
            }
            function set(e) {
                if (currentKw() == "for") {
                    if (e.kind == "Starred")
                        error(9562, pxt.U.lf("iterable unpacking cannot be used in comprehension"));
                    let r = mkAST("SetComp", t0);
                    r.elt = e;
                    r.generators = comp_for();
                    return finish(r);
                }
                let r = mkAST("Set", t0);
                r.elts = [e];
                if (currentOp() == "Comma") {
                    let rem = parseParenthesizedList("RBracket", pxt.U.lf("set element"), star_or_test);
                    r.elts = [e].concat(rem);
                }
                else {
                    expectOp("RBracket");
                }
                return finish(r);
            }
            function dictelt() {
                if (currentOp() == "Pow") {
                    shiftToken();
                    return [null, expr()];
                }
                else {
                    let e = test();
                    expectOp("Colon");
                    return [e, test()];
                }
            }
            function dict(key0, value0) {
                if (currentKw() == "for") {
                    if (!key0)
                        error(9563, pxt.U.lf("dict unpacking cannot be used in dict comprehension"));
                    let r = mkAST("DictComp", t0);
                    r.key = key0;
                    r.value = value0;
                    r.generators = comp_for();
                    return finish(r);
                }
                let r = mkAST("Dict", t0);
                r.keys = [key0];
                r.values = [value0];
                if (currentOp() == "Comma") {
                    let rem = parseParenthesizedList("RBracket", pxt.U.lf("dict element"), dictelt);
                    for (let e of rem) {
                        if (e.length >= 2 && e[0] && e[1]) {
                            r.keys.push(e[0]);
                            r.values.push(e[1]);
                        }
                    }
                }
                else {
                    expectOp("RBracket");
                }
                return finish(r);
            }
        }
        function shiftAndFake() {
            let r = mkAST("NameConstant");
            r.value = null;
            shiftToken();
            return finish(r);
        }
        function atom() {
            let t = peekToken();
            if (t.type == py.TokenType.Id) {
                let r = mkAST("Name");
                shiftToken();
                r.id = t.value;
                r.ctx = "Load";
                return finish(r);
            }
            else if (t.type == py.TokenType.Number) {
                let r = mkAST("Num");
                shiftToken();
                r.ns = t.value;
                r.n = t.auxValue;
                return finish(r);
            }
            else if (t.type == py.TokenType.String) {
                shiftToken();
                let s = t.value;
                while (peekToken().type == py.TokenType.String) {
                    s += peekToken().value;
                    shiftToken();
                }
                if (t.stringPrefix == "b") {
                    let r = mkAST("Bytes", t);
                    r.s = pxt.U.toArray(pxt.U.stringToUint8Array(s));
                    return finish(r);
                }
                else {
                    let r = mkAST("Str", t);
                    r.s = s;
                    return finish(r);
                }
            }
            else if (t.type == py.TokenType.Keyword) {
                if (t.value == "None" || t.value == "True" || t.value == "False") {
                    let r = mkAST("NameConstant");
                    shiftToken();
                    r.value = t.value == "True" ? true : t.value == "False" ? false : null;
                    return finish(r);
                }
                else {
                    error(9564, pxt.U.lf("expecting atom"));
                    return shiftAndFake();
                }
            }
            else if (t.type == py.TokenType.Op) {
                let o = t.value;
                if (o == "LParen") {
                    return parseParens("RParen", "Tuple", "GeneratorExp");
                }
                else if (o == "LSquare") {
                    return parseParens("RSquare", "List", "ListComp");
                }
                else if (o == "LBracket") {
                    return dictorsetmaker();
                }
                else {
                    error(9565, pxt.U.lf("unexpected operator"));
                    return shiftAndFake();
                }
            }
            else {
                error(9566, pxt.U.lf("unexpected token"));
                return shiftAndFake();
            }
        }
        function atListEnd() {
            let op = currentOp();
            if (op == "RParen" || op == "RSquare" || op == "RBracket" ||
                op == "Colon" || op == "Semicolon")
                return true;
            if (pxt.U.endsWith(op, "Assign"))
                return true;
            let kw = currentKw();
            if (kw == "in")
                return true;
            if (peekToken().type == py.TokenType.NewLine)
                return true;
            return false;
        }
        function parseList(category, f) {
            let r = [];
            if (atListEnd())
                return r;
            for (;;) {
                r.push(f());
                let hasComma = currentOp() == "Comma";
                if (hasComma)
                    shiftToken();
                // final comma is allowed, so no "else if" here
                if (atListEnd()) {
                    return r;
                }
                else {
                    if (!hasComma) {
                        error(9567, pxt.U.lf("expecting {0}", category));
                        return r;
                    }
                }
            }
        }
        function parseSepList(category, f) {
            let r = [];
            for (;;) {
                r.push(f());
                if (currentOp() == "Comma")
                    shiftToken();
                else
                    break;
            }
            return r;
        }
        function parseParenthesizedList(cl, category, f) {
            shiftToken();
            let r = [];
            if (currentOp() != cl)
                for (;;) {
                    r.push(f());
                    let hasComma = currentOp() == "Comma";
                    if (hasComma)
                        shiftToken();
                    // final comma is allowed, so no "else if" here
                    if (currentOp() == cl) {
                        break;
                    }
                    else {
                        if (!hasComma) {
                            error(9568, pxt.U.lf("expecting {0}", category));
                            break;
                        }
                    }
                }
            expectOp(cl);
            return r;
        }
        function parseParens(cl, tuple, comp) {
            let t0 = peekToken();
            shiftToken();
            if (currentOp() == cl) {
                shiftToken();
                let r = mkAST(tuple, t0);
                r.elts = [];
                return finish(r);
            }
            let e0 = star_or_test();
            if (currentKw() == "for") {
                let r = mkAST(comp, t0);
                r.elt = e0;
                r.generators = comp_for();
                expectOp(cl);
                return finish(r);
            }
            if (currentOp() == "Comma") {
                let r = mkAST(tuple, t0);
                shiftToken();
                r.elts = parseList(pxt.U.lf("expression"), star_or_test);
                r.elts.unshift(e0);
                expectOp(cl);
                return finish(r);
            }
            expectOp(cl);
            if (tuple == "List") {
                let r = mkAST(tuple, t0);
                r.elts = [e0];
                return finish(r);
            }
            return e0;
        }
        function name() {
            let t = peekToken();
            if (t.type != py.TokenType.Id)
                error(9569, pxt.U.lf("expecting identifier"));
            shiftToken();
            return t.value;
        }
        function parseArgs() {
            let args = parseParenthesizedList("RParen", pxt.U.lf("argument"), argument);
            let rargs = [];
            let rkeywords = [];
            for (let e of args) {
                if (e.kind == "Keyword")
                    rkeywords.push(e);
                else {
                    if (rkeywords.length)
                        error(9570, pxt.U.lf("positional argument follows keyword argument"));
                    rargs.push(e);
                }
            }
            return { args: rargs, keywords: rkeywords };
        }
        function trailer(t0, e) {
            let o = currentOp();
            if (o == "LParen") {
                let r = mkAST("Call", t0);
                r.func = e;
                let rr = parseArgs();
                r.args = rr.args;
                r.keywords = rr.keywords;
                return finish(r);
            }
            else if (o == "LSquare") {
                let t1 = peekToken();
                let r = mkAST("Subscript", t0);
                r.value = e;
                let sl = parseParenthesizedList("RSquare", pxt.U.lf("subscript"), subscript);
                if (sl.length == 0)
                    error(9571, pxt.U.lf("need non-empty index list"));
                else if (sl.length == 1)
                    r.slice = sl[0];
                else {
                    if (sl.every(s => s.kind == "Index")) {
                        let q = sl[0];
                        q.value = tuple(t1, sl.map(e => e.value));
                        r.slice = q;
                    }
                    else {
                        let extSl = mkAST("ExtSlice", t1);
                        extSl.dims = sl;
                        r.slice = finish(extSl);
                    }
                }
                return finish(r);
            }
            else if (o == "Dot") {
                let r = mkAST("Attribute", t0);
                r.value = e;
                shiftToken();
                r.attr = name();
                return finish(r);
            }
            else {
                return e;
            }
        }
        function atom_expr() {
            let t0 = peekToken();
            let e = atom();
            for (;;) {
                let ee = trailer(t0, e);
                if (ee === e)
                    return e;
                e = ee;
            }
        }
        function power() {
            let t0 = peekToken();
            let e = atom_expr();
            if (currentOp() == "Pow") {
                let r = mkAST("BinOp");
                shiftToken();
                r.left = e;
                r.op = "Pow";
                r.right = factor();
                return finish(r);
            }
            else {
                return e;
            }
        }
        function factor() {
            if (unOpMap[currentOp()]) {
                let r = mkAST("UnaryOp");
                r.op = unOpMap[currentOp()];
                shiftToken();
                r.operand = factor();
                return finish(r);
            }
            else {
                return power();
            }
        }
        const fieldOrder = {
            kind: 1, id: 2, n: 3, s: 4, func: 5, key: 6, elt: 7, elts: 8, keys: 9, left: 10,
            ops: 11, comparators: 12, names: 13, items: 14, test: 15, targets: 16, dims: 17,
            context_expr: 18, name: 19, bases: 20, type: 21, inClass: 22, target: 23,
            annotation: 24, simple: 25, op: 26, operand: 27, right: 28, values: 29, iter: 30,
            ifs: 31, is_async: 32, value: 33, slice: 34, attr: 35, generators: 36, args: 37,
            keywords: 38, body: 39, handlers: 40, orelse: 41, finalbody: 42, decorator_list: 43,
            kwonlyargs: 44, kw_defaults: 45, defaults: 46, arg: 47,
        };
        const fieldsIgnore = {
            lineno: 1,
            col_offset: 1,
            startPos: 1,
            endPos: 1,
            kind: 1,
        };
        const stmtFields = {
            body: 1,
            orelse: 1,
            finalbody: 1
        };
        const cmpIgnore = {
            _comments: 1,
            ctx: 1,
            ns: 1,
        };
        function dump(asts, cmp = false) {
            const rec = (ind, v) => {
                if (Array.isArray(v)) {
                    let s = "";
                    for (let i = 0; i < v.length; ++i) {
                        if (i > 0)
                            s += ", ";
                        s += rec(ind, v[i]);
                    }
                    return "[" + s + "]";
                }
                if (!v || !v.kind)
                    return JSON.stringify(v);
                let r = "";
                let keys = Object.keys(v);
                keys.sort((a, b) => (fieldOrder[a] || 100) - (fieldOrder[b] || 100) || pxt.U.strcmp(a, b));
                for (let k of keys) {
                    if (pxt.U.lookup(fieldsIgnore, k))
                        continue;
                    if (cmp && pxt.U.lookup(cmpIgnore, k))
                        continue;
                    if (r)
                        r += ", ";
                    r += k + "=";
                    if (Array.isArray(v[k]) && v[k].length && pxt.U.lookup(stmtFields, k)) {
                        r += "[\n";
                        let i2 = ind + "  ";
                        for (let e of v[k]) {
                            r += i2 + rec(i2, e) + "\n";
                        }
                        r += ind + "]";
                    }
                    else if (k == "_comments") {
                        r += "[\n";
                        let i2 = ind + "  ";
                        for (let e of v[k]) {
                            r += i2 + JSON.stringify(e.value) + "\n";
                        }
                        r += ind + "]";
                    }
                    else {
                        r += rec(ind, v[k]);
                    }
                }
                return v.kind + "(" + r + ")";
            };
            let r = "";
            for (let e of asts) {
                r += rec("", e) + "\n";
            }
            return r;
        }
        py.dump = dump;
        function parse(_source, _filename, _tokens) {
            source = _source;
            filename = _filename;
            tokens = _tokens;
            inParens = 0;
            nextToken = 0;
            currComments = [];
            indentStack = [0];
            diags = [];
            let res = [];
            try {
                prevToken = tokens[0];
                skipTokens();
                if (peekToken().type != py.TokenType.EOF) {
                    res = stmt();
                    while (peekToken().type != py.TokenType.EOF)
                        pxt.U.pushRange(res, stmt());
                }
            }
            catch (e) {
                error(9572, pxt.U.lf("exception: {0}", e.message));
            }
            return {
                stmts: res,
                diagnostics: diags
            };
        }
        py.parse = parse;
    })(py = pxt.py || (pxt.py = {}));
})(pxt || (pxt = {}));
var pxt;
(function (pxt) {
    var py;
    (function (py) {
        function decompileToPython(program, filename) {
            let result = emptyResult();
            try {
                let output = tsToPy(program, filename);
                let outFilename = filename.replace(/(\.py)?\.\w*$/i, '') + '.py';
                result.outfiles[outFilename] = output;
            }
            catch (e) {
                if (e.pyDiagnostic)
                    result.diagnostics = [e.pyDiagnostic];
                else
                    pxt.reportException(e);
                result.success = false;
            }
            return result;
        }
        py.decompileToPython = decompileToPython;
        function emptyResult() {
            return {
                blocksInfo: undefined,
                outfiles: {},
                diagnostics: [],
                success: true,
                times: {}
            };
        }
        function throwError(node, code, messageText) {
            const diag = {
                fileName: node.getSourceFile().fileName,
                start: node.getStart(),
                length: node.getEnd() - node.getStart(),
                line: undefined,
                column: undefined,
                code,
                category: pxtc.DiagnosticCategory.Error,
                messageText,
            };
            const err = new Error(messageText);
            err.pyDiagnostic = diag;
            throw err;
        }
        ///
        /// FLAGS
        ///
        const SUPPORT_LAMBDAS = false;
        const SUPPORT_CLASSES = false;
        ///
        /// UTILS
        ///
        py.INDENT = "    ";
        function indent(lvl) {
            return s => (s || "").split('\n').map(line => `${py.INDENT.repeat(lvl)}${line}`).join('\n');
        }
        py.indent = indent;
        py.indent1 = indent(1);
        // TODO handle types at initialization when ambiguous (e.g. x = [], x = None)
        function tsToPy(prog, filename) {
            // helpers
            const tc = prog.getTypeChecker();
            const lhost = new ts.pxtc.LSHost(prog);
            // const ls = ts.createLanguageService(lhost) // TODO
            const file = prog.getSourceFile(filename);
            const commentMap = pxtc.decompiler.buildCommentMap(file);
            const reservedWords = pxt.U.toSet(getReservedNmes(), s => s);
            const [renameMap, globalNames] = ts.pxtc.decompiler.buildRenameMap(prog, file, { takenNames: reservedWords, declarations: "all" });
            const allSymbols = pxtc.getApiInfo(prog);
            const symbols = pxt.U.mapMap(allSymbols.byQName, 
            // filter out symbols from the .ts corresponding to this file
            (k, v) => v.fileName == filename ? undefined : v);
            // For debugging:
            // return toStringVariableScopes(file)
            // variables analysis
            const scopeLookup = py.computeScopeVariableLookup(file);
            // ts->py
            return emitFile(file);
            ///
            /// ENVIRONMENT
            ///
            function getReservedNmes() {
                const reservedNames = ['ArithmeticError', 'AssertionError', 'AttributeError',
                    'BaseException', 'BlockingIOError', 'BrokenPipeError', 'BufferError', 'BytesWarning',
                    'ChildProcessError', 'ConnectionAbortedError', 'ConnectionError',
                    'ConnectionRefusedError', 'ConnectionResetError', 'DeprecationWarning', 'EOFError',
                    'Ellipsis', 'EnvironmentError', 'Exception', 'False', 'FileExistsError',
                    'FileNotFoundError', 'FloatingPointError', 'FutureWarning', 'GeneratorExit', 'IOError',
                    'ImportError', 'ImportWarning', 'IndentationError', 'IndexError',
                    'InterruptedError', 'IsADirectoryError', 'KeyError', 'KeyboardInterrupt', 'LookupError',
                    'MemoryError', 'NameError', 'None', 'NotADirectoryError', 'NotImplemented',
                    'NotImplementedError', 'OSError', 'OverflowError', 'PendingDeprecationWarning',
                    'PermissionError', 'ProcessLookupError', 'RecursionError', 'ReferenceError',
                    'ResourceWarning', 'RuntimeError', 'RuntimeWarning', 'StopAsyncIteration',
                    'StopIteration', 'SyntaxError', 'SyntaxWarning', 'SystemError', 'SystemExit',
                    'TabError', 'TimeoutError', 'True', 'TypeError', 'UnboundLocalError',
                    'UnicodeDecodeError', 'UnicodeEncodeError', 'UnicodeError', 'UnicodeTranslateError',
                    'UnicodeWarning', 'UserWarning', 'ValueError', 'Warning', 'ZeroDivisionError', '_',
                    '__build_class__', '__debug__', '__doc__', '__import__', '__loader__', '__name__',
                    '__package__', '__spec__', 'abs', 'all', 'any', 'ascii', 'bin', 'bool',
                    'bytearray', 'bytes', 'callable', 'chr', 'classmethod', 'compile', 'complex',
                    'copyright', 'credits', 'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval',
                    'exec', 'exit', 'filter', 'float', 'format', 'frozenset', 'getattr',
                    'globals', 'hasattr', 'hash', 'help', 'hex', 'id', 'input', 'int',
                    'isinstance', 'issubclass', 'iter', 'len', 'license', 'list', 'locals', 'map',
                    'max', 'memoryview', 'min', 'next', 'object', 'oct', 'open', 'ord', 'pow',
                    'print', 'property', 'quit', 'range', 'repr', 'reversed', 'round', 'set',
                    'setattr', 'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple',
                    'type', 'vars', 'zip',
                    ...Object.keys(pxt.py.keywords)
                ];
                return reservedNames;
            }
            function tryGetSymbol(exp) {
                if (!exp.getSourceFile())
                    return null;
                let tsExp = exp.getText();
                return symbols[tsExp] || null;
            }
            function tryGetPyName(exp) {
                if (!exp.getSourceFile())
                    return null;
                let tsExp = exp.getText();
                const tsSym = tc.getSymbolAtLocation(exp);
                if (tsSym) {
                    tsExp = tc.getFullyQualifiedName(tsSym);
                }
                let sym = symbols[tsExp];
                if (sym && sym.attributes.alias) {
                    return sym.attributes.alias;
                }
                if (sym && sym.pyQName) {
                    if (sym.isInstance) {
                        if (ts.isPropertyAccessExpression(exp)) {
                            // If this is a property access on an instance, we should bail out
                            // because the left-hand side might contain an expression
                            return null;
                        }
                        // If the pyQname is "Array.append" we just want "append"
                        const nameRegExp = new RegExp(`(?:^|\.)${sym.namespace}\.(.+)`);
                        const match = nameRegExp.exec(sym.pyQName);
                        if (match)
                            return match[1];
                    }
                    return sym.pyQName;
                }
                else if (tsExp in pxtc.ts2PyFunNameMap) {
                    return pxtc.ts2PyFunNameMap[tsExp].n;
                }
                return null;
            }
            function getName(name) {
                let pyName = tryGetPyName(name);
                if (pyName)
                    return pyName;
                if (!ts.isIdentifier(name)) {
                    pxt.tickEvent("depython.todo.advancedname");
                    return throwError(name, 3001, "Unsupported advanced name format: " + name.getText());
                }
                let outName = name.text;
                let hasSrc = name.getSourceFile();
                if (hasSrc) {
                    const rename = renameMap.getRenameForPosition(name.getStart());
                    if (rename) {
                        outName = rename.name;
                    }
                }
                return outName;
            }
            function getNewGlobalName(nameHint) {
                // TODO right now this uses a global name set, but really there should be options to allow shadowing
                if (typeof nameHint !== "string")
                    nameHint = getName(nameHint);
                if (globalNames[nameHint]) {
                    return pxtc.decompiler.getNewName(nameHint, globalNames);
                }
                else {
                    globalNames[nameHint] = true;
                    return nameHint;
                }
            }
            ///
            /// TYPE UTILS
            ///
            function hasTypeFlag(t, fs) {
                return (t.flags & fs) !== 0;
            }
            function isType(s, fs) {
                let type = tc.getTypeAtLocation(s);
                return hasTypeFlag(type, fs);
            }
            function isStringType(s) {
                return isType(s, ts.TypeFlags.StringLike);
            }
            function isNumberType(s) {
                return isType(s, ts.TypeFlags.NumberLike);
            }
            ///
            /// NEWLINES, COMMENTS, and WRAPPERS
            ///
            function emitFile(file) {
                // emit file
                let outLns = file.getChildren()
                    .map(emitNode)
                    .reduce((p, c) => p.concat(c), [])
                    .reduce((p, c) => {
                    if (!c && !p[p.length - 1]) {
                        // if there are consecutive empty lines, reduce those to just one
                        return p;
                    }
                    else {
                        return [...p, c];
                    }
                }, []);
                // emit any comments that could not be associated with a
                // statement at the end of the file
                commentMap.filter(c => !c.owner)
                    .forEach(comment => outLns.push(...emitComment(comment)));
                return outLns.join("\n");
            }
            function emitNode(s) {
                switch (s.kind) {
                    case ts.SyntaxKind.SyntaxList:
                        return s._children
                            .map(emitNode)
                            .reduce((p, c) => p.concat(c), []);
                    case ts.SyntaxKind.EndOfFileToken:
                    case ts.SyntaxKind.OpenBraceToken:
                    case ts.SyntaxKind.CloseBraceToken:
                        return [];
                    default:
                        return emitStmtWithNewlines(s);
                }
            }
            function emitComment(comment) {
                let out = [];
                if (comment.kind === pxtc.decompiler.CommentKind.SingleLine) {
                    out.push("# " + comment.text);
                }
                else {
                    out.push(`"""`);
                    for (const line of comment.lines) {
                        out.push(line);
                    }
                    out.push(`"""`);
                }
                return out;
            }
            function emitStmtWithNewlines(s) {
                const out = emitStmt(s);
                // get comments after emit so that child nodes get a chance to claim them
                const comments = pxtc.decompiler.getCommentsForStatement(s, commentMap)
                    .map(emitComment)
                    .reduce((p, c) => p.concat(c), []);
                return comments.concat(out);
            }
            ///
            /// STATEMENTS
            ///
            function emitStmt(s) {
                if (ts.isVariableStatement(s)) {
                    return emitVarStmt(s);
                }
                else if (ts.isClassDeclaration(s)) {
                    return emitClassStmt(s);
                }
                else if (ts.isEnumDeclaration(s)) {
                    return emitEnumStmt(s);
                }
                else if (ts.isExpressionStatement(s)) {
                    return emitExpStmt(s);
                }
                else if (ts.isFunctionDeclaration(s)) {
                    return emitFuncDecl(s);
                }
                else if (ts.isIfStatement(s)) {
                    return emitIf(s);
                }
                else if (ts.isForStatement(s)) {
                    return emitForStmt(s);
                }
                else if (ts.isForOfStatement(s)) {
                    return emitForOfStmt(s);
                }
                else if (ts.isWhileStatement(s)) {
                    return emitWhileStmt(s);
                }
                else if (ts.isReturnStatement(s)) {
                    return emitReturnStmt(s);
                }
                else if (ts.isBlock(s)) {
                    return emitBlock(s);
                }
                else if (ts.isTypeAliasDeclaration(s)) {
                    return emitTypeAliasDecl(s);
                }
                else if (ts.isEmptyStatement(s)) {
                    return [];
                }
                else if (ts.isModuleDeclaration(s)) {
                    return emitModuleDeclaration(s);
                }
                else if (ts.isBreakStatement(s)) {
                    return ['break'];
                }
                else if (ts.isContinueStatement(s)) {
                    return ['continue'];
                }
                else {
                    pxt.tickEvent("depython.todo.statement", { statement: s.kind });
                    return throwError(s, 3002, `Not supported in MakeCode Python: ${ts.SyntaxKind[s.kind]} (${s.kind})`);
                }
            }
            function emitModuleDeclaration(s) {
                let name = getName(s.name);
                let stmts = s.body && s.body.getChildren()
                    .map(emitNode)
                    .reduce((p, c) => p.concat(c), [])
                    .map(n => py.indent1(n));
                return [`@namespace`, `class ${name}:`].concat(stmts || []);
            }
            function emitTypeAliasDecl(s) {
                let typeStr = pxtc.emitPyTypeFromTypeNode(s.type);
                let name = getName(s.name);
                return [`${name} = ${typeStr}`];
            }
            function emitReturnStmt(s) {
                if (!s.expression)
                    return ['return'];
                let [exp, expSup] = emitExp(s.expression);
                let stmt = expWrap("return ", exp);
                return expSup.concat(stmt);
            }
            function emitWhileStmt(s) {
                let [cond, condSup] = emitExp(s.expression);
                let body = emitBody(s.statement);
                let whileStmt = expWrap("while ", cond, ":");
                return condSup.concat(whileStmt).concat(body);
            }
            function isNormalInteger(str) {
                let asInt = Math.floor(Number(str));
                return asInt !== Infinity && String(asInt) === str;
            }
            function getSimpleForRange(s) {
                // must be (let i = X; ...)
                if (!s.initializer)
                    return null;
                if (s.initializer.kind !== ts.SyntaxKind.VariableDeclarationList)
                    return null;
                let initDecls = s.initializer;
                if (initDecls.declarations.length !== 1) {
                    return null;
                }
                let decl = initDecls.declarations[0];
                let result_name = getName(decl.name);
                if (!decl.initializer || !isConstExp(decl.initializer) || !isNumberType(decl.initializer)) {
                    // TODO allow variables?
                    // TODO restrict to numbers?
                    return null;
                }
                let [fromNum, fromNumSup] = emitExp(decl.initializer);
                if (fromNumSup.length)
                    return null;
                let result_fromIncl = expToStr(fromNum);
                // TODO body must not mutate loop variable
                // must be (...; i < Y; ...)
                if (!s.condition)
                    return null;
                if (!ts.isBinaryExpression(s.condition))
                    return null;
                if (!ts.isIdentifier(s.condition.left))
                    return null;
                if (getName(s.condition.left) != result_name)
                    return null;
                // TODO restrict initializers to expressions that aren't modified by the loop
                // e.g. isConstExp(s.condition.right) but more semantic
                if (!isNumberType(s.condition.right)) {
                    return null;
                }
                let [toNumExp, toNumSup] = emitExp(s.condition.right);
                if (toNumSup.length)
                    return null;
                let toNum = expToStr(toNumExp);
                let result_toExcl = toNum;
                if (s.condition.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken
                    && isNormalInteger(toNum)) {
                    // Note that we have to be careful here because
                    // <= 3.5 is not the same as < 4.5
                    // so we only want to handle <= when the toNum is very well behaved
                    result_toExcl = "" + (Number(toNum) + 1);
                }
                else if (s.condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken)
                    return null;
                // must be (...; i++)
                // TODO allow += 1
                if (!s.incrementor)
                    return null;
                if (!ts.isPostfixUnaryExpression(s.incrementor)
                    && !ts.isPrefixUnaryExpression(s.incrementor))
                    return null;
                if (s.incrementor.operator !== ts.SyntaxKind.PlusPlusToken)
                    return null;
                // must be X < Y
                if (!(result_fromIncl < result_toExcl))
                    return null;
                let result = {
                    name: result_name,
                    fromIncl: result_fromIncl,
                    toExcl: result_toExcl
                };
                return result;
            }
            function emitBody(s) {
                let body = emitStmt(s)
                    .map(py.indent1);
                if (body.length < 1)
                    body = [py.indent1("pass")];
                return body;
            }
            function emitForOfStmt(s) {
                if (!ts.isVariableDeclarationList(s.initializer)) {
                    pxt.tickEvent("depython.todo.forof.complexexp");
                    return throwError(s, 3003, "Unsupported expression in for..of initializer: " + s.initializer.getText());
                }
                let names = s.initializer.declarations
                    .map(d => getName(d.name));
                if (names.length !== 1) {
                    pxt.tickEvent("depython.todo.forof.multidecl");
                    return throwError(s, 3004, "Unsupported multiple declerations in for..of: " + s.initializer.getText()); // TODO
                }
                let name = names[0];
                let [exp, expSup] = emitExp(s.expression);
                let out = expSup;
                out = out.concat(expWrap(`for ${name} in `, exp, ":"));
                let body = emitBody(s.statement);
                out = out.concat(body);
                return out;
            }
            function emitForStmt(s) {
                let rangeItr = getSimpleForRange(s);
                if (rangeItr) {
                    // special case (aka "repeat z times" block):
                    // for (let x = y; x < z; x++)
                    // ->
                    // for x in range(y, z):
                    // TODO ensure x and z can't be mutated in the loop body
                    let { name, fromIncl, toExcl } = rangeItr;
                    let forStmt = fromIncl === "0"
                        ? `for ${name} in range(${toExcl}):`
                        : `for ${name} in range(${fromIncl}, ${toExcl}):`;
                    let body = emitBody(s.statement);
                    return [forStmt].concat(body);
                }
                // general case:
                // for (<inits>; <cond>; <updates>)
                // ->
                // <inits>
                // while <cond>:
                //   # body
                //   <updates>
                let out = [];
                // initializer(s)
                if (s.initializer) {
                    if (ts.isVariableDeclarationList(s.initializer)) {
                        let decls = s.initializer.declarations
                            .map(emitVarDecl)
                            .reduce((p, c) => p.concat(c), []);
                        out = out.concat(decls);
                    }
                    else {
                        let [exp, expSup] = emitExp(s.initializer);
                        out = out.concat(expSup).concat(exp);
                    }
                }
                // condition(s)
                let cond;
                if (s.condition) {
                    let [condStr, condSup] = emitExp(s.condition);
                    out = out.concat(condSup);
                    cond = expToStr(condStr);
                }
                else {
                    cond = "True";
                }
                let whileStmt = `while ${cond}:`;
                out.push(whileStmt);
                // body
                let body = emitStmt(s.statement)
                    .map(py.indent1);
                if (body.length === 0 && !s.incrementor)
                    body = [py.indent1("pass")];
                out = out.concat(body);
                // updater(s)
                if (s.incrementor) {
                    let unaryIncDec = tryEmitIncDecUnaryStmt(s.incrementor);
                    if (unaryIncDec) {
                        // special case: ++ or --
                        out = out.concat(unaryIncDec.map(py.indent1));
                    }
                    else {
                        // general case
                        let [inc, incSup] = emitExp(s.incrementor);
                        out = out.concat(incSup)
                            .concat(inc.map(py.indent1));
                    }
                }
                return out;
            }
            function emitIf(s) {
                let { supportStmts, ifStmt, rest } = emitIfHelper(s);
                return supportStmts.concat([ifStmt]).concat(rest);
            }
            function emitIfHelper(s) {
                let sup = [];
                let [cond, condSup] = emitExp(s.expression);
                sup = sup.concat(condSup);
                let ifStmt = `if ${expToStr(cond)}:`;
                let ifRest = [];
                let th = emitBody(s.thenStatement);
                ifRest = ifRest.concat(th);
                if (s.elseStatement) {
                    if (ts.isIfStatement(s.elseStatement)) {
                        let { supportStmts, ifStmt, rest } = emitIfHelper(s.elseStatement);
                        let elif = `el${ifStmt}`;
                        sup = sup.concat(supportStmts);
                        ifRest.push(elif);
                        ifRest = ifRest.concat(rest);
                    }
                    else {
                        ifRest.push("else:");
                        let el = emitBody(s.elseStatement);
                        ifRest = ifRest.concat(el);
                    }
                }
                return { supportStmts: sup, ifStmt: ifStmt, rest: ifRest };
            }
            function emitVarStmt(s) {
                let decls = s.declarationList.declarations;
                return decls
                    .map(emitVarDecl)
                    .reduce((p, c) => p.concat(c), []);
            }
            function emitClassStmt(s) {
                if (!SUPPORT_CLASSES) {
                    pxt.tickEvent("depython.todo.classes");
                    return throwError(s, 3016, "Unsupported: classes are not supported in Python right now.");
                }
                let out = [];
                // TODO handle inheritence
                if (!s.name) {
                    pxt.tickEvent("depython.todo.anonymousclass");
                    return throwError(s, 3011, "Unsupported: anonymous class");
                }
                let isEnum = s.members.every(isEnumMem); // TODO hack?
                let name = getName(s.name);
                if (isEnum)
                    out.push(`class ${name}(Enum):`);
                else
                    out.push(`class ${name}:`);
                let mems = s.members
                    .map(emitClassMem)
                    .reduce((p, c) => p.concat(c), [])
                    .filter(m => m);
                if (mems.length) {
                    out = out.concat(mems.map(py.indent1));
                }
                return out;
            }
            function emitEnumStmt(s) {
                let out = [];
                out.push(`class ${getName(s.name)}(Enum):`);
                let allInit = s.members
                    .every(m => !!m.initializer);
                let noInit = !s.members
                    .every(m => !!m.initializer);
                if (!allInit && !noInit) {
                    pxt.tickEvent("depython.todo.enummix");
                    return throwError(s, 3005, "Unsupported enum decleration: has mixture of explicit and implicit initialization");
                }
                if (allInit) {
                    // TODO
                    // let memAndSup = s.members
                    //     .map(m => [m, emitExp(m.initializer)] as [ts.EnumMember, ExpRes])
                    pxt.tickEvent("depython.todo.enuminit");
                    return throwError(s, 3006, "Unsupported: explicit enum initialization");
                }
                let val = 0;
                for (let m of s.members) {
                    out.push(py.indent1(`${getName(m.name)} = ${val++}`));
                }
                return out;
            }
            function isEnumMem(s) {
                if (s.kind !== ts.SyntaxKind.PropertyDeclaration)
                    return false;
                let prop = s;
                if (!prop.modifiers || prop.modifiers.length !== 1)
                    return false;
                for (let mod of prop.modifiers)
                    if (mod.kind !== ts.SyntaxKind.StaticKeyword)
                        return false;
                if (!prop.initializer)
                    return false;
                if (prop.initializer.kind !== ts.SyntaxKind.NumericLiteral)
                    return false;
                return true;
            }
            function emitClassMem(s) {
                if (ts.isPropertyDeclaration(s))
                    return emitPropDecl(s);
                else if (ts.isMethodDeclaration(s))
                    return emitFuncDecl(s);
                else if (ts.isConstructorDeclaration(s)) {
                    return emitConstructor(s);
                }
                return ["# unknown ClassElement " + s.kind];
            }
            function emitConstructor(s) {
                let res = [];
                const memberProps = s.parameters
                    // parameters with "public" prefix are class members
                    .filter(ts.isParameterPropertyDeclaration);
                memberProps.forEach(p => {
                    // emit each parameter property as a member decl
                    res = [...res, ...emitPropDecl(p)];
                });
                // emit the constructor body
                res = [...res, ...emitFuncDecl(s, "__init__")];
                if (memberProps.length && res.slice(-1)[0].endsWith("pass"))
                    res.pop(); // slight hack b/c we're appending body statements
                memberProps.forEach(p => {
                    // emit each parameter property's initial assignment
                    const nm = getName(p.name);
                    res.push(py.indent1(`self.${nm} = ${nm}`));
                });
                return res;
            }
            function emitDefaultValue(t) {
                // TODO: reconcile with snippet.ts:getDefaultValueOfType. Unfortunately, doing so is complicated.
                if (hasTypeFlag(t, ts.TypeFlags.NumberLike))
                    return "0";
                else if (hasTypeFlag(t, ts.TypeFlags.StringLike))
                    return `""`;
                else if (hasTypeFlag(t, ts.TypeFlags.BooleanLike))
                    return "False";
                // TODO: support more types
                return undefined;
            }
            function emitPropDecl(s) {
                let nm = getName(s.name);
                if (s.initializer) {
                    let [init, initSup] = emitExp(s.initializer);
                    return [...initSup, `${nm} = ${expToStr(init)}`];
                }
                else if (ts.isParameterPropertyDeclaration(s) && s.type) {
                    const t = tc.getTypeFromTypeNode(s.type);
                    const defl = emitDefaultValue(t);
                    if (defl) {
                        return [`${nm} = ${defl}`];
                    }
                }
                // can't do declerations without initilization in python
                pxt.tickEvent("depython.todo.classwithoutinit");
                return throwError(s, 3006, "Unsupported: class properties without initializers");
            }
            function isUnaryPlusPlusOrMinusMinus(e) {
                if (!ts.isPrefixUnaryExpression(e) &&
                    !ts.isPostfixUnaryExpression(e))
                    return false;
                if (e.operator !== ts.SyntaxKind.MinusMinusToken &&
                    e.operator !== ts.SyntaxKind.PlusPlusToken)
                    return false;
                return true;
            }
            function tryEmitIncDecUnaryStmt(e) {
                // special case ++ or -- as a statement
                if (!isUnaryPlusPlusOrMinusMinus(e))
                    return null;
                let [operand, sup] = emitExp(e.operand);
                let incDec = e.operator === ts.SyntaxKind.MinusMinusToken ? " -= 1" : " += 1";
                let out = sup;
                out.push(`${expToStr(operand)}${incDec}`);
                return out;
            }
            function emitExpStmt(s) {
                let unaryExp = tryEmitIncDecUnaryStmt(s.expression);
                if (unaryExp)
                    return unaryExp;
                const [exp, expSup] = emitExp(s.expression);
                if (expSup.length)
                    // If an expression has supporting statements, this is usually an event handler
                    // and we usually want it to be padded with empty lines.
                    return ["", ...expSup, ...exp, ""];
                else
                    return [...expSup, ...exp];
            }
            function emitBlock(s) {
                const stmts = s.getChildren()
                    .map(emitNode)
                    .reduce((p, c) => p.concat(c), []);
                return stmts;
            }
            function emitFuncDecl(s, name, altParams, skipTypes) {
                // TODO determine captured variables, then determine global and nonlocal directives
                // TODO helper function for determining if an expression can be a python expression
                let paramList = [];
                if (s.kind === ts.SyntaxKind.MethodDeclaration ||
                    s.kind === ts.SyntaxKind.Constructor) {
                    paramList.push("self");
                }
                let paramDeclDefs = altParams ? mergeParamDecls(s.parameters, altParams) : s.parameters;
                let paramDecls = paramDeclDefs
                    .map(d => emitParamDecl(d, !skipTypes));
                paramList = paramList.concat(paramDecls);
                let params = paramList.join(", ");
                let out = [];
                let fnName;
                if (name)
                    fnName = name;
                else if (s.name)
                    fnName = getName(s.name);
                else {
                    pxt.tickEvent("depython.todo.anonymousfunc");
                    return throwError(s, 3012, "Unsupported: anonymous function decleration");
                }
                out.push(`def ${fnName}(${params}):`);
                if (!s.body) {
                    pxt.tickEvent("depython.todo.funcwithoutbody");
                    return throwError(s, 3013, "Unsupported: function decleration without body");
                }
                let stmts = [];
                if (ts.isBlock(s.body))
                    stmts = emitBlock(s.body);
                else {
                    let [exp, sup] = emitExp(s.body);
                    stmts = stmts.concat(sup);
                    stmts.concat(exp);
                }
                if (stmts.length) {
                    // global or nonlocal declerations
                    let globals = scopeLookup.getExplicitGlobals(s)
                        .map(g => getName(g));
                    if (globals && globals.length)
                        stmts.unshift(`global ${globals.join(", ")}`);
                    let nonlocals = scopeLookup.getExplicitNonlocals(s)
                        .map(n => getName(n));
                    if (nonlocals && nonlocals.length)
                        stmts.unshift(`nonlocal ${nonlocals.join(", ")}`);
                    out = out.concat(stmts.map(py.indent1));
                }
                else {
                    out.push(py.indent1("pass")); // cannot have an empty body
                }
                return out;
            }
            function emitParamDecl(s, inclTypesIfAvail = true) {
                let nm = s.altName || getName(s.name);
                let typePart = "";
                if (s.type && inclTypesIfAvail) {
                    let typ = pxtc.emitPyTypeFromTypeNode(s.type);
                    if (typ && typ.indexOf("(TODO") === -1) {
                        typePart = `: ${typ}`;
                    }
                }
                let initPart = "";
                if (s.initializer) {
                    let [initExp, initSup] = emitExp(s.initializer);
                    if (initSup.length) {
                        pxt.tickEvent("depython.todo.complexinit");
                        return throwError(s, 3007, `Unsupported: complex expression in parameter default value not supported. Expression: ${s.initializer.getText()}`);
                    }
                    initPart = ` = ${expToStr(initExp)}`;
                }
                return `${nm}${typePart}${initPart}`;
            }
            function emitVarDecl(s) {
                let out = [];
                let varNm = getName(s.name);
                // out.push(`#let ${varNm}`) // TODO debug
                // varNm = introVar(varNm, s.name)
                if (s.initializer) {
                    // TODO
                    // let syms = tc.getSymbolsInScope(s, ts.SymbolFlags.Variable)
                    // let symTxt = "#@ " + syms.map(s => s.name).join(", ")
                    // out.push(symTxt)
                    let [exp, expSup] = emitExp(s.initializer);
                    out = out.concat(expSup);
                    let declStmt;
                    if (s.type) {
                        let translatedType = pxtc.emitPyTypeFromTypeNode(s.type);
                        declStmt = `${varNm}: ${translatedType} = ${expToStr(exp)}`;
                    }
                    else {
                        declStmt = `${varNm} = ${expToStr(exp)}`;
                    }
                    out.push(declStmt);
                    return out;
                }
                else {
                    // can't do declerations without initilization in python
                }
                return out;
            }
            function asExpRes(str, sup) {
                return [[str], sup || []];
            }
            function expToStr(exps, char = '\n') {
                return exps.join(char);
            }
            function expWrap(pre = "", exps, suff = "") {
                exps[0] = pre + exps[0];
                exps[exps.length - 1] = exps[exps.length - 1] + suff;
                return exps;
            }
            function emitOp(s, node) {
                switch (s) {
                    case ts.SyntaxKind.BarBarToken:
                        return "or";
                    case ts.SyntaxKind.AmpersandAmpersandToken:
                        return "and";
                    case ts.SyntaxKind.ExclamationToken:
                        return "not";
                    case ts.SyntaxKind.LessThanToken:
                        return "<";
                    case ts.SyntaxKind.LessThanEqualsToken:
                        return "<=";
                    case ts.SyntaxKind.GreaterThanToken:
                        return ">";
                    case ts.SyntaxKind.GreaterThanEqualsToken:
                        return ">=";
                    case ts.SyntaxKind.EqualsEqualsEqualsToken:
                    case ts.SyntaxKind.EqualsEqualsToken:
                        // TODO distinguish === from == ?
                        return "==";
                    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
                    case ts.SyntaxKind.ExclamationEqualsToken:
                        // TODO distinguish !== from != ?
                        return "!=";
                    case ts.SyntaxKind.EqualsToken:
                        return "=";
                    case ts.SyntaxKind.PlusToken:
                        return "+";
                    case ts.SyntaxKind.MinusToken:
                        return "-";
                    case ts.SyntaxKind.AsteriskToken:
                        return "*";
                    case ts.SyntaxKind.PlusEqualsToken:
                        return "+=";
                    case ts.SyntaxKind.MinusEqualsToken:
                        return "-=";
                    case ts.SyntaxKind.PercentToken:
                        return "%";
                    case ts.SyntaxKind.SlashToken:
                        return "/";
                    case ts.SyntaxKind.PlusPlusToken:
                    case ts.SyntaxKind.MinusMinusToken:
                        // TODO handle "--" & "++" generally. Seperate prefix and postfix cases.
                        // This is tricky because it needs to return the value and the mutate after.
                        pxt.tickEvent("depython.todo.unsupportedop", { op: s });
                        return throwError(node, 3008, "Unsupported ++ and -- in an expression (not a statement or for loop)");
                    case ts.SyntaxKind.AmpersandToken:
                        return "&";
                    case ts.SyntaxKind.CaretToken:
                        return "^";
                    case ts.SyntaxKind.LessThanLessThanToken:
                        return "<<";
                    case ts.SyntaxKind.GreaterThanGreaterThanToken:
                        return ">>";
                    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
                        pxt.tickEvent("depython.todo.unsupportedop", { op: s });
                        return throwError(node, 3009, "Unsupported operator: >>>");
                    case ts.SyntaxKind.AsteriskAsteriskToken:
                        return "**";
                    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
                        return "**=";
                    case ts.SyntaxKind.PercentEqualsToken:
                        return "%=";
                    case ts.SyntaxKind.AsteriskEqualsToken:
                        return "*=";
                    case ts.SyntaxKind.SlashEqualsToken:
                        return "/=";
                    default:
                        pxt.tickEvent("depython.todo.unsupportedop", { op: s });
                        return throwError(node, 3008, `Unsupported Python operator (code: ${s})`);
                }
            }
            function emitBinExp(s) {
                // handle string concatenation
                // TODO handle implicit type conversions more generally
                let isLStr = isStringType(s.left);
                let isRStr = isStringType(s.right);
                let isStrConcat = s.operatorToken.kind === ts.SyntaxKind.PlusToken
                    && (isLStr || isRStr);
                let [left, leftSup] = emitExp(s.left);
                if (isStrConcat && !isLStr)
                    left = expWrap("str(", left, ")");
                let op = emitOp(s.operatorToken.kind, s);
                let [right, rightSup] = emitExp(s.right);
                if (isStrConcat && !isRStr)
                    right = expWrap("str(", right, ")");
                let sup = leftSup.concat(rightSup);
                return [expWrap(expToStr(left) + " " + op + " ", right), sup];
            }
            function emitDotExp(s) {
                // short-circuit if the dot expression is a well-known symbol
                let pyName = tryGetPyName(s);
                if (pyName)
                    return asExpRes(pyName);
                let [left, leftSup] = emitExp(s.expression);
                let right = getName(s.name);
                // special: foo.length
                if (right === "length") {
                    // TODO confirm the type is correct!
                    return asExpRes(`len(${expToStr(left)})`, leftSup);
                }
                return asExpRes(`${expToStr(left)}.${right}`, leftSup);
            }
            function getSimpleExpNameParts(s) {
                if (ts.isPropertyAccessExpression(s)) {
                    let nmPart = getName(s.name);
                    let nmRight = nmPart.substr(nmPart.lastIndexOf(".") + 1);
                    if (ts.isIdentifier(s.expression)) {
                        return [nmRight];
                    }
                    return getSimpleExpNameParts(s.expression).concat([nmRight]);
                }
                else if (ts.isIdentifier(s)) {
                    return [getName(s)];
                }
                else // TODO handle more cases like indexing?
                    return [];
            }
            function getNameHint(param, calleeExp, allParams, allArgs) {
                // get words from the callee
                let calleePart = "";
                if (calleeExp)
                    calleePart = getSimpleExpNameParts(calleeExp)
                        .map(pxt.U.snakify)
                        .join("_");
                // get words from the previous parameter(s)/arg(s)
                let enumParamParts = [];
                if (allParams && allParams.length > 1 && allArgs && allArgs.length > 1) {
                    // special case: if there are enum parameters, use those as part of the hint
                    for (let i = 0; i < allParams.length && i < allArgs.length; i++) {
                        let arg = allArgs[i];
                        let argType = tc.getTypeAtLocation(arg);
                        if (hasTypeFlag(argType, ts.TypeFlags.EnumLike)) {
                            let argParts = getSimpleExpNameParts(arg)
                                .map(pxt.U.snakify);
                            enumParamParts = enumParamParts.concat(argParts);
                        }
                    }
                }
                let otherParamsPart = enumParamParts.join("_");
                // get words from this parameter/arg as last resort
                let paramPart = "";
                if (!calleePart && !otherParamsPart && param)
                    paramPart = getName(param.name);
                // the full hint
                let hint = [calleePart, otherParamsPart, paramPart]
                    .filter(s => s)
                    .map(pxt.U.snakify)
                    .map(s => s.toLowerCase())
                    .join("_") || "my_callback";
                // sometimes the full hint is too long so shorten them using some heuristics
                // 1. remove duplicate words
                // e.g. controller_any_button_on_event_controller_button_event_pressed_callback
                //   -> controller_any_button_on_event_pressed_callback
                let allWords = hint.split("_");
                if (allWords.length > 4) {
                    allWords = dedupWords(allWords);
                }
                // 2. remove less-informative words
                let lessUsefulWords = pxt.U.toDictionary(["any", "on", "event"], s => s);
                while (allWords.length > 2) {
                    let newWords = removeOne(allWords, lessUsefulWords);
                    if (newWords.length == allWords.length)
                        break;
                    allWords = newWords;
                }
                // 3. add an "on_" prefix
                allWords = ["on", ...allWords];
                return allWords.join("_");
                function dedupWords(words) {
                    let usedWords = {};
                    let out = [];
                    for (let w of words) {
                        if (w in usedWords)
                            continue;
                        usedWords[w] = true;
                        out.push(w);
                    }
                    return out;
                }
                function removeOne(words, exclude) {
                    let out = [];
                    let oneExcluded = false;
                    for (let w of words) {
                        if (w in exclude && !oneExcluded) {
                            oneExcluded = true;
                            continue;
                        }
                        out.push(w);
                    }
                    return out;
                }
            }
            // determine whether a comma-separated list (array, function parameters) should
            // use newlines to separate items
            function getCommaSep(exps) {
                let res = exps.join(", ");
                if (res.length > 60 && exps.length > 1) {
                    return exps.map((el, i) => {
                        let sep = el.charAt(el.length - 1) == "," ? "" : ",";
                        if (i == 0) {
                            let lines = el.split('\n');
                            // for multiline element, indent all lines after first
                            if (lines.length > 1) {
                                let first = lines.shift();
                                el = first + '\n' + py.indent1(lines.join('\n'));
                            }
                            return el + sep;
                        }
                        else if (i == exps.length - 1) {
                            return py.indent1(el);
                        }
                        else {
                            return py.indent1(el + sep);
                        }
                    });
                }
                return [res];
            }
            function emitArgExp(s, param, calleeExp, allParams, allArgs) {
                // special case: function arguments to higher-order functions
                // reason 1: if the argument is a function and the parameter it is being passed to is also a function type,
                // then we want to pass along the parameter's function parameters to emitFnExp so that the argument will fit the
                // parameter type. This is because TypeScript/Javascript allows passing a function with fewer parameters to an
                // argument that is a function with more parameters while Python does not.
                // Key example: callbacks
                // this code compiles in TS:
                //      function onEvent(callback: (a: number) => void) { ... }
                //      onEvent(function () { ... })
                // yet in python this is not allowed, we have to add more parameters to the anonymous declaration to match like this:
                //      onEvent(function (a: number) { ... })
                // see "callback_num_args.ts" test case for more details.
                // reason 2: we want to generate good names, which requires context about the function it is being passed to an other parameters
                if ((ts.isFunctionExpression(s) || ts.isArrowFunction(s)) && param) {
                    if (param.type && ts.isFunctionTypeNode(param.type)) {
                        // TODO(dz): uncomment to support reason #1 above. I've disabled this for now because it generates uglier
                        // code if we don't have support in py2ts to reverse this
                        // let altParams = param.type.parameters
                        let altParams = undefined;
                        let fnNameHint = getNameHint(param, calleeExp, allParams, allArgs);
                        return emitFnExp(s, fnNameHint, altParams, true);
                    }
                }
                return emitExp(s);
            }
            function emitCallExp(s) {
                // get callee parameter info
                let calleeType = tc.getTypeAtLocation(s.expression);
                let calleeTypeNode = tc.typeToTypeNode(calleeType);
                let calleeParameters = ts.createNodeArray([]);
                if (ts.isFunctionTypeNode(calleeTypeNode)) {
                    calleeParameters = calleeTypeNode.parameters;
                    if (s.arguments && calleeParameters.length < s.arguments.length) {
                        pxt.tickEvent("depython.todo.argparammismatch", { kind: s.kind });
                        return throwError(s, 3010, "TODO: Unsupported call site where caller the arguments outnumber the callee parameters: " + s.getText());
                    }
                }
                // special case TD_ID function, don't emit them
                const sym = tryGetSymbol(s.expression);
                if (s.arguments && sym && sym.attributes.shim == "TD_ID") {
                    // this function is a no-op and should not be emitted
                    return emitExp(s.arguments[0]);
                }
                // special case .toString
                if (ts.isPropertyAccessExpression(s.expression)) {
                    if (s.expression.name.getText() === "toString") {
                        const [inner, innerSup] = emitExp(s.expression.expression);
                        return [expWrap(`str(`, inner, `)`), innerSup];
                    }
                }
                // TODO inspect type info to rewrite things like console.log, Math.max, etc.
                let [fnExp, fnSup] = emitExp(s.expression);
                let fn = expToStr(fnExp);
                let sargs = s.arguments || ts.createNodeArray();
                let argExps = sargs
                    .map((a, i, allArgs) => emitArgExp(a, calleeParameters[i], s.expression, calleeParameters, allArgs));
                let sup = argExps
                    .map(([_, aSup]) => aSup)
                    .reduce((p, c) => p.concat(c), fnSup);
                // special handling for python<->ts helpers
                if (fn.indexOf("_py.py_") === 0) {
                    if (argExps.length <= 0) {
                        pxt.tickEvent("depython.todo._pynoargs");
                        return throwError(s, 3014, "Unsupported: call expression has no arguments for _py.py_ fn");
                    }
                    // The format is _py.py_type_name, so remove the type
                    fn = fn.substr(7).split("_").filter((_, i) => i !== 0).join("_");
                    const recv = argExps.shift()[0];
                    const args = getCommaSep(argExps.map(([a, _]) => a).reduce((p, c) => p.concat(c), []));
                    return [expWrap(`${recv}.${fn}(`, args, ")"), sup];
                }
                let args = getCommaSep(argExps.map(([a, _]) => a).reduce((p, c) => p.concat(c), [])); //getCommaSep(argExps.map(([a, _]) => a));
                return [expWrap(`${fn}(`, args, ")"), sup];
            }
            function mergeParamDecls(primary, alt) {
                // Note: possible name collisions between primary and alt parameters is handled by marking
                // alt parameters as "unused" so that we can generate them new names without renaming
                let decls = [];
                let paramNames = {};
                for (let i = 0; i < Math.max(primary.length, alt.length); i++) {
                    let p;
                    if (primary[i]) {
                        p = primary[i];
                        paramNames[getName(p.name)] = true;
                    }
                    else {
                        p = alt[i];
                        let name = getName(p.name);
                        if (paramNames[name]) {
                            name = pxtc.decompiler.getNewName(name, paramNames);
                            p = Object.assign({ altName: name }, alt[i]);
                        }
                    }
                    decls.push(p);
                }
                return ts.createNodeArray(decls, false);
            }
            function emitFnExp(s, nameHint, altParams, skipType) {
                // if the anonymous function is simple enough, use a lambda
                if (SUPPORT_LAMBDAS && !ts.isBlock(s.body)) {
                    // TODO we're speculatively emitting this expression. This speculation is only safe if emitExp is pure, which it's not quite today (e.g. getNewGlobalName)
                    let [fnBody, fnSup] = emitExp(s.body);
                    if (fnSup.length === 0) {
                        let paramDefs = altParams ? mergeParamDecls(s.parameters, altParams) : s.parameters;
                        let paramList = paramDefs
                            .map(p => emitParamDecl(p, false))
                            .join(", ");
                        let stmt = paramList.length
                            ? `lambda ${paramList}: ${expToStr(fnBody)}`
                            : `lambda: ${expToStr(fnBody)}`;
                        return asExpRes(stmt);
                    }
                }
                // otherwise emit a standard "def myFunction(...)" declaration
                let fnName = s.name ? getName(s.name) : getNewGlobalName(nameHint || "my_function");
                let fnDef = emitFuncDecl(s, fnName, altParams, skipType);
                return asExpRes(fnName, fnDef);
            }
            function getUnaryOpSpacing(s) {
                switch (s) {
                    case ts.SyntaxKind.ExclamationToken: // not
                        return " ";
                    case ts.SyntaxKind.PlusToken:
                    case ts.SyntaxKind.MinusToken:
                        return "";
                    default:
                        return " ";
                }
            }
            function emitPreUnaryExp(s) {
                let op = emitOp(s.operator, s);
                let [exp, expSup] = emitExp(s.operand);
                // TODO handle order-of-operations ? parenthesis?
                let space = getUnaryOpSpacing(s.operator);
                let res = `${op}${space}${expToStr(exp)}`;
                return asExpRes(res, expSup);
            }
            function emitPostUnaryExp(s) {
                let op = emitOp(s.operator, s);
                let [exp, expSup] = emitExp(s.operand);
                // TODO handle order-of-operations ? parenthesis?
                let space = getUnaryOpSpacing(s.operator);
                let res = `${expToStr(exp)}${space}${op}`;
                return asExpRes(res, expSup);
            }
            function emitArrayLitExp(s) {
                let els = s.elements
                    .map(emitExp);
                let sup = els
                    .map(([_, sup]) => sup)
                    .reduce((p, c) => p.concat(c), []);
                let inner = getCommaSep(els.map(([e, _]) => e).reduce((p, c) => p.concat(c), []));
                return [expWrap("[", inner, "]"), sup];
            }
            function emitElAccessExp(s) {
                if (!s.argumentExpression) {
                    pxt.tickEvent("depython.todo.accesswithoutexp");
                    return throwError(s, 3015, "Unsupported: element access expression without an argument expression");
                }
                let [left, leftSup] = emitExp(s.expression);
                let [arg, argSup] = emitExp(s.argumentExpression);
                let sup = leftSup.concat(argSup);
                let exp = `${expToStr(left)}[${expToStr(arg)}]`;
                return asExpRes(exp, sup);
            }
            function emitParenthesisExp(s) {
                let [inner, innerSup] = emitExp(s.expression);
                return asExpRes(`(${expToStr(inner)})`, innerSup);
            }
            function emitMultiLnStrLitExp(s) {
                if (ts.isNoSubstitutionTemplateLiteral(s)) {
                    return asExpRes(`"""\n${py.indent1(s.text.trim())}\n"""`);
                }
                let [tag, tagSup] = emitExp(s.tag);
                let [temp, tempSup] = emitExp(s.template);
                let sup = tagSup.concat(tempSup);
                let exp = `${expToStr(tag)}(${expToStr(temp)})`;
                return asExpRes(exp, sup);
            }
            function emitIdentifierExp(s) {
                // TODO disallow keywords and built-ins?
                // TODO why isn't undefined showing up as a keyword?
                // let id = s.text;
                if (s.text == "undefined")
                    return asExpRes("None");
                let name = getName(s);
                return asExpRes(name);
            }
            function visitExp(s, fn) {
                let visitRecur = (s) => visitExp(s, fn);
                if (ts.isBinaryExpression(s)) {
                    return visitRecur(s.left) && visitRecur(s.right);
                }
                else if (ts.isPropertyAccessExpression(s)) {
                    return visitRecur(s.expression);
                }
                else if (ts.isPrefixUnaryExpression(s) || ts.isPostfixUnaryExpression(s)) {
                    return s.operator !== ts.SyntaxKind.PlusPlusToken
                        && s.operator !== ts.SyntaxKind.MinusMinusToken
                        && visitRecur(s.operand);
                }
                else if (ts.isParenthesizedExpression(s)) {
                    return visitRecur(s.expression);
                }
                else if (ts.isArrayLiteralExpression(s)) {
                    return s.elements
                        .map(visitRecur)
                        .reduce((p, c) => p && c, true);
                }
                else if (ts.isElementAccessExpression(s)) {
                    return visitRecur(s.expression)
                        && (!s.argumentExpression || visitRecur(s.argumentExpression));
                }
                return fn(s);
            }
            function getParent(node) {
                if (!node.parent) {
                    return undefined;
                }
                else if (node.parent.kind === ts.SyntaxKind.ParenthesizedExpression) {
                    return getParent(node.parent);
                }
                else {
                    return node.parent;
                }
            }
            function isDecompilableAsExpression(n) {
                // The only time we allow casts to decompile is in the very special case where someone has
                // written a program comparing two string, boolean, or numeric literals in blocks and
                // converted to text. e.g. 3 == 5 or true != false
                if (n.type.getText().trim() === "any" && (ts.isNumericLiteral(n.expression) || ts.isStringLiteral(n.expression) ||
                    n.expression.kind === ts.SyntaxKind.TrueKeyword || n.expression.kind === ts.SyntaxKind.FalseKeyword)) {
                    const parent = getParent(n);
                    if ((parent === null || parent === void 0 ? void 0 : parent.kind) === ts.SyntaxKind.BinaryExpression) {
                        switch (parent.operatorToken.kind) {
                            case ts.SyntaxKind.EqualsEqualsToken:
                            case ts.SyntaxKind.EqualsEqualsEqualsToken:
                            case ts.SyntaxKind.ExclamationEqualsToken:
                            case ts.SyntaxKind.ExclamationEqualsEqualsToken:
                            case ts.SyntaxKind.LessThanToken:
                            case ts.SyntaxKind.LessThanEqualsToken:
                            case ts.SyntaxKind.GreaterThanToken:
                            case ts.SyntaxKind.GreaterThanEqualsToken:
                                return true;
                            default:
                                break;
                        }
                    }
                }
                return false;
            }
            function isConstExp(s) {
                let isConst = (s) => {
                    switch (s.kind) {
                        case ts.SyntaxKind.PropertyAccessExpression:
                        case ts.SyntaxKind.BinaryExpression:
                        case ts.SyntaxKind.ParenthesizedExpression:
                        case ts.SyntaxKind.ArrayLiteralExpression:
                        case ts.SyntaxKind.ElementAccessExpression:
                        case ts.SyntaxKind.TrueKeyword:
                        case ts.SyntaxKind.FalseKeyword:
                        case ts.SyntaxKind.NullKeyword:
                        case ts.SyntaxKind.UndefinedKeyword:
                        case ts.SyntaxKind.NumericLiteral:
                        case ts.SyntaxKind.StringLiteral:
                        case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
                            return true;
                        case ts.SyntaxKind.CallExpression:
                        case ts.SyntaxKind.NewExpression:
                        case ts.SyntaxKind.FunctionExpression:
                        case ts.SyntaxKind.ArrowFunction:
                        case ts.SyntaxKind.Identifier:
                        case ts.SyntaxKind.ThisKeyword:
                            return false;
                        case ts.SyntaxKind.PrefixUnaryExpression:
                        case ts.SyntaxKind.PostfixUnaryExpression:
                            let e = s;
                            return e.operator !== ts.SyntaxKind.PlusPlusToken
                                && e.operator !== ts.SyntaxKind.MinusMinusToken;
                    }
                    return false;
                };
                return visitExp(s, isConst);
            }
            function emitCondExp(s) {
                let [cond, condSup] = emitExp(s.condition);
                let [tru, truSup] = emitExp(s.whenTrue);
                let [fls, flsSup] = emitExp(s.whenFalse);
                let sup = condSup.concat(truSup).concat(flsSup);
                let exp = `${tru} if ${expToStr(cond)} else ${expToStr(fls)}`;
                return asExpRes(exp, sup);
            }
            function emitExp(s) {
                if (ts.isBinaryExpression(s))
                    return emitBinExp(s);
                if (ts.isPropertyAccessExpression(s))
                    return emitDotExp(s);
                if (ts.isCallExpression(s))
                    return emitCallExp(s);
                if (ts.isNewExpression(s))
                    return emitCallExp(s);
                if (ts.isFunctionExpression(s) || ts.isArrowFunction(s))
                    return emitFnExp(s);
                if (ts.isPrefixUnaryExpression(s))
                    return emitPreUnaryExp(s);
                if (ts.isPostfixUnaryExpression(s))
                    return emitPostUnaryExp(s);
                if (ts.isParenthesizedExpression(s))
                    return emitParenthesisExp(s);
                if (ts.isArrayLiteralExpression(s))
                    return emitArrayLitExp(s);
                if (ts.isElementAccessExpression(s))
                    return emitElAccessExp(s);
                if (ts.isNoSubstitutionTemplateLiteral(s) || ts.isTaggedTemplateExpression(s))
                    return emitMultiLnStrLitExp(s);
                switch (s.kind) {
                    case ts.SyntaxKind.TrueKeyword:
                        return asExpRes("True");
                    case ts.SyntaxKind.FalseKeyword:
                        return asExpRes("False");
                    case ts.SyntaxKind.ThisKeyword:
                        return asExpRes("self");
                    case ts.SyntaxKind.NullKeyword:
                    case ts.SyntaxKind.UndefinedKeyword:
                        return asExpRes("None");
                }
                if (ts.isIdentifier(s))
                    return emitIdentifierExp(s);
                if (ts.isNumericLiteral(s) || ts.isStringLiteral(s))
                    // TODO handle weird syntax?
                    return asExpRes(s.getText());
                if (ts.isConditionalExpression(s))
                    return emitCondExp(s);
                if (ts.isAsExpression(s) && isDecompilableAsExpression(s))
                    return emitExp(s.expression);
                // TODO handle more expressions
                pxt.tickEvent("depython.todo.expression", { kind: s.kind });
                // return asExpRes(s.getText(), ["# unknown expression:  " + s.kind]) // uncomment for easier locating
                return throwError(s, 3017, "Unsupported expression kind: " + s.kind);
            }
        }
    })(py = pxt.py || (pxt.py = {}));
})(pxt || (pxt = {}));
var pxt;
(function (pxt) {
    var py;
    (function (py) {
        var rx;
        (function (rx) {
            const nonASCIIwhitespace = /[\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
            function isIdentifierStart(code) {
                return ts.pxtc.isIdentifierStart(code, ts.pxtc.ScriptTarget.ES5);
            }
            rx.isIdentifierStart = isIdentifierStart;
            function isIdentifierChar(code) {
                return ts.pxtc.isIdentifierPart(code, ts.pxtc.ScriptTarget.ES5);
            }
            rx.isIdentifierChar = isIdentifierChar;
            function isSpace(ch) {
                if (ch === 32 || // ' '
                    ch === 9 || ch === 11 || ch === 12 || // TODO check this with CPython
                    ch === 160 || // '\xa0'
                    ch >= 0x1680 && nonASCIIwhitespace.test(String.fromCharCode(ch))) {
                    return true;
                }
                return false;
            }
            rx.isSpace = isSpace;
            function isNewline(ch) {
                if (ch === 10 || ch === 13)
                    return true;
                // Python ref doesn't really say LINE SEPARATOR and PARAGRAPH SEPARATOR
                // are line seperators, but how else should we treat them?
                if (ch === 0x2028 || ch === 0x2029)
                    return true;
                return false;
            }
            rx.isNewline = isNewline;
        })(rx = py.rx || (py.rx = {}));
    })(py = pxt.py || (pxt.py = {}));
})(pxt || (pxt = {}));
var pxt;
(function (pxt) {
    var py;
    (function (py) {
        function isAssignmentExpression(s) {
            // why is this not built in...
            const AssignmentOperators = [
                ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken,
                ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
                ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken,
                ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.LessThanLessThanEqualsToken,
                ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
                ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
                ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken,
                ts.SyntaxKind.CaretEqualsToken
            ];
            return ts.isBinaryExpression(s)
                && AssignmentOperators.some(o => s.operatorToken.kind === o);
        }
        function computeVarScopes(node) {
            const EMPTY = { refs: [], children: [], owner: undefined };
            return walk(node);
            function walk(s) {
                var _a;
                if (!s)
                    return EMPTY;
                // ignore these subtrees because identifiers
                // in here are not variable usages
                if (ts.isPropertyAccessOrQualifiedName(s))
                    return EMPTY;
                // variable usage
                if (ts.isIdentifier(s)) {
                    return {
                        refs: [{
                                kind: "read",
                                node: s,
                                varName: s.text
                            }],
                        children: [],
                        owner: undefined
                    };
                }
                // variable decleration
                if (ts.isVariableDeclaration(s) || ts.isParameter(s)) {
                    const init = walk(s.initializer);
                    return {
                        refs: [...init.refs, {
                                kind: "decl",
                                node: s,
                                varName: s.name.getText()
                            }],
                        children: init.children,
                        owner: undefined
                    };
                }
                // variable assignment
                if (ts.isPrefixUnaryExpression(s) || ts.isPostfixUnaryExpression(s)) {
                    const operandUse = walk(s.operand);
                    const varName = s.operand.getText();
                    const assign = {
                        refs: [{
                                kind: "assign",
                                node: s,
                                varName,
                            }],
                        children: [],
                        owner: undefined
                    };
                    return merge(operandUse, assign);
                }
                if (isAssignmentExpression(s)) {
                    const rightUse = walk(s.right);
                    let leftUse;
                    if (s.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
                        leftUse = walk(s.left);
                    }
                    const varName = s.left.getText();
                    const assign = {
                        refs: [{
                                kind: "assign",
                                node: s,
                                varName,
                            }],
                        children: [],
                        owner: undefined
                    };
                    return merge(leftUse, merge(rightUse, assign));
                }
                // new scope
                if (ts.isFunctionExpression(s)
                    || ts.isArrowFunction(s)
                    || ts.isFunctionDeclaration(s)
                    || ts.isMethodDeclaration(s)) {
                    const fnName = (_a = s.name) === null || _a === void 0 ? void 0 : _a.getText();
                    let fnDecl = undefined;
                    if (fnName) {
                        fnDecl = {
                            kind: "decl",
                            node: s,
                            varName: fnName
                        };
                    }
                    const params = s.parameters
                        .map(p => walk(p))
                        .reduce(merge, EMPTY);
                    const body = walk(s.body);
                    const child = merge(params, body);
                    child.owner = s;
                    return {
                        refs: fnDecl ? [fnDecl] : [],
                        children: [child],
                        owner: undefined
                    };
                }
                // keep walking
                return s.getChildren()
                    .map(walk)
                    .reduce(merge, EMPTY);
            }
            function merge(p, n) {
                if (!p || !n)
                    return p || n || EMPTY;
                return {
                    refs: [...p.refs, ...n.refs],
                    children: [...p.children, ...n.children],
                    owner: p.owner || n.owner
                };
            }
        }
        function getExplicitGlobals(u) {
            return [...u.globalUsage, ...u.environmentUsage]
                .filter(r => r.kind === "assign")
                .map(r => r);
        }
        function getExplicitNonlocals(u) {
            return u.nonlocalUsage
                .filter(r => r.kind === "assign")
                .map(r => r);
        }
        function computeVarUsage(s, globals, nonlocals = []) {
            const globalUsage = [];
            const nonlocalUsage = [];
            const localUsage = [];
            const environmentUsage = [];
            const locals = {};
            for (const r of s.refs) {
                if (r.kind === "read" || r.kind === "assign") {
                    if (locals[r.varName])
                        localUsage.push(r);
                    else if (lookupNonlocal(r))
                        nonlocalUsage.push(r);
                    else if (globals && globals[r.varName])
                        globalUsage.push(r);
                    else
                        environmentUsage.push(r);
                }
                else {
                    locals[r.varName] = r;
                }
            }
            const nextGlobals = globals || locals;
            const nextNonlocals = globals ? [...nonlocals, locals] : [];
            const children = s.children
                .map(s => computeVarUsage(s, nextGlobals, nextNonlocals));
            return {
                globalUsage,
                nonlocalUsage,
                localUsage,
                environmentUsage,
                children,
                owner: s.owner
            };
            function lookupNonlocal(use) {
                return nonlocals
                    .map(d => d[use.varName])
                    .reduce((p, n) => n || p, undefined);
            }
        }
        function computeScopeVariableLookup(n) {
            const scopeInfo = computeVarScopes(n);
            const usageInfo = computeVarUsage(scopeInfo);
            const globalsByFn = new Map();
            const nonlocalsByFn = new Map();
            walk(usageInfo);
            return {
                getExplicitGlobals: (fn) => globalsByFn.get(fn) || [],
                getExplicitNonlocals: (fn) => nonlocalsByFn.get(fn) || [],
            };
            function toId(a) {
                let i = a.node.operand
                    || a.node.left;
                return ts.isIdentifier(i) ? i : undefined;
            }
            function toIds(ns) {
                return ns
                    .map(toId)
                    .filter(i => !!i)
                    .map(i => i)
                    .reduce((p, n) => p.find(r => r.text === n.text) ? p : [...p, n], []);
            }
            function walk(s) {
                const gs = toIds(getExplicitGlobals(s));
                globalsByFn.set(s.owner, gs);
                const ls = toIds(getExplicitNonlocals(s));
                nonlocalsByFn.set(s.owner, ls);
                s.children.forEach(walk);
            }
        }
        py.computeScopeVariableLookup = computeScopeVariableLookup;
        // printing
        function toStringVarRef(i) {
            return `${i.kind}:${i.varName}`;
        }
        function toStringVarScopes(s) {
            function internalToStringVarScopes(s) {
                const refs = s.refs.map(toStringVarRef).join(", ");
                const children = s.children
                    .map(internalToStringVarScopes)
                    .map(c => c.map(py.indent1))
                    .map(c => ["{", ...c, "}"])
                    .reduce((p, n) => [...p, ...n], []);
                return [
                    refs,
                    ...children
                ];
            }
            return internalToStringVarScopes(s).join("\n");
        }
        function toStringVarUsage(s) {
            function internalToStringVarUsage(s) {
                const gs = s.globalUsage.map(toStringVarRef).join(', ');
                const ns = s.nonlocalUsage.map(toStringVarRef).join(', ');
                const ls = s.localUsage.map(toStringVarRef).join(', ');
                const es = s.environmentUsage.map(toStringVarRef).join(', ');
                const children = s.children
                    .map(internalToStringVarUsage)
                    .map(c => c.map(py.indent1))
                    .map(c => ["{", ...c, "}"])
                    .reduce((p, n) => [...p, ...n], []);
                return [
                    gs ? "global " + gs : "",
                    ns ? "nonlocal " + ns : "",
                    ls ? "local " + ls : "",
                    es ? "env " + es : "",
                    ...children
                ].filter(i => !!i);
            }
            return internalToStringVarUsage(s).join("\n");
        }
        // for debugging
        function toStringVariableScopes(n) {
            const varScopes = computeVarScopes(n);
            const varUsage = computeVarUsage(varScopes);
            return toStringVarScopes(varScopes) + "\n\n\n" + toStringVarUsage(varUsage);
        }
        py.toStringVariableScopes = toStringVariableScopes;
    })(py = pxt.py || (pxt.py = {}));
})(pxt || (pxt = {}));
