///<reference path='../localtypings/pxtblockly.d.ts'/>
/// <reference path="../built/pxtlib.d.ts" />
let iface;
var pxt;
(function (pxt) {
    var blocks;
    (function (blocks_1) {
        function workerOpAsync(op, arg) {
            return pxt.worker.getWorker(pxt.webConfig.workerjs).opAsync(op, arg);
        }
        blocks_1.workerOpAsync = workerOpAsync;
        let placeholders = {};
        const MAX_COMMENT_LINE_LENGTH = 50;
        ///////////////////////////////////////////////////////////////////////////////
        // Miscellaneous utility functions
        ///////////////////////////////////////////////////////////////////////////////
        // Mutate [a1] in place and append to it the elements from [a2].
        function append(a1, a2) {
            a1.push.apply(a1, a2);
        }
        // A few wrappers for basic Block operations that throw errors when compilation
        // is not possible. (The outer code catches these and highlights the relevant
        // block.)
        // Internal error (in our code). Compilation shouldn't proceed.
        function assert(x) {
            if (!x)
                throw new Error("Assertion failure");
        }
        function throwBlockError(msg, block) {
            let e = new Error(msg);
            e.block = block;
            throw e;
        }
        ///////////////////////////////////////////////////////////////////////////////
        // Types
        //
        // We slap a very simple type system on top of Blockly. This is needed to ensure
        // we generate valid TouchDevelop code (otherwise compilation from TD to C++
        // would not work).
        ///////////////////////////////////////////////////////////////////////////////
        // There are several layers of abstraction for the type system.
        // - Block are annotated with a string return type, and a string type for their
        //   input blocks (see blocks-custom.js). We use that as the reference semantics
        //   for the blocks.
        // - In this "type system", we use the enum Type. Using an enum rules out more
        //   mistakes.
        // - When emitting code, we target the "TouchDevelop types".
        //
        // Type inference / checking is done as follows. First, we try to assign a type
        // to all variables. We do this by examining all variable assignments and
        // figuring out the type from the right-hand side. There's a fixpoint computation
        // (see [mkEnv]). Then, we propagate down the expected type when doing code
        // generation; when generating code for a variable dereference, if the expected
        // type doesn't match the inferred type, it's an error. If the type was
        // undetermined as of yet, the type of the variable becomes the expected type.
        class Point {
            constructor(link, type, parentType, childType, isArrayType) {
                this.link = link;
                this.type = type;
                this.parentType = parentType;
                this.childType = childType;
                this.isArrayType = isArrayType;
            }
        }
        blocks_1.Point = Point;
        let BlockDeclarationType;
        (function (BlockDeclarationType) {
            BlockDeclarationType[BlockDeclarationType["None"] = 0] = "None";
            BlockDeclarationType[BlockDeclarationType["Argument"] = 1] = "Argument";
            BlockDeclarationType[BlockDeclarationType["Assigned"] = 2] = "Assigned";
            BlockDeclarationType[BlockDeclarationType["Implicit"] = 3] = "Implicit";
        })(BlockDeclarationType = blocks_1.BlockDeclarationType || (blocks_1.BlockDeclarationType = {}));
        function find(p) {
            if (p.link)
                return find(p.link);
            return p;
        }
        function union(p1, p2) {
            let _p1 = find(p1);
            let _p2 = find(p2);
            assert(_p1.link == null && _p2.link == null);
            if (_p1 == _p2)
                return;
            if (_p1.childType && _p2.childType) {
                const ct = _p1.childType;
                _p1.childType = null;
                union(ct, _p2.childType);
            }
            else if (_p1.childType && !_p2.childType) {
                _p2.childType = _p1.childType;
            }
            if (_p1.parentType && _p2.parentType) {
                const pt = _p1.parentType;
                _p1.parentType = null;
                union(pt, _p2.parentType);
            }
            else if (_p1.parentType && !_p2.parentType && !_p2.type) {
                _p2.parentType = _p1.parentType;
            }
            let t = unify(_p1.type, _p2.type);
            p1.link = _p2;
            _p1.link = _p2;
            _p1.isArrayType = _p2.isArrayType;
            p1.type = null;
            p2.type = t;
        }
        // Ground types.
        function mkPoint(t, isArrayType = false) {
            return new Point(null, t, null, null, isArrayType);
        }
        const pNumber = mkPoint("number");
        const pBoolean = mkPoint("boolean");
        const pString = mkPoint("string");
        const pUnit = mkPoint("void");
        function ground(t) {
            if (!t)
                return mkPoint(t);
            switch (t.toLowerCase()) {
                case "number": return pNumber;
                case "boolean": return pBoolean;
                case "string": return pString;
                case "void": return pUnit;
                default:
                    // Unification variable.
                    return mkPoint(t);
            }
        }
        ///////////////////////////////////////////////////////////////////////////////
        // Type inference
        //
        // Expressions are now directly compiled as a tree. This requires knowing, for
        // each property ref, the right value for its [parent] property.
        ///////////////////////////////////////////////////////////////////////////////
        // Infers the expected type of an expression by looking at the untranslated
        // block and figuring out, from the look of it, what type of expression it
        // holds.
        function returnType(e, b) {
            assert(b != null);
            if (isPlaceholderBlock(b)) {
                if (!b.p)
                    b.p = mkPoint(null);
                return find(b.p);
            }
            if (b.type == "variables_get")
                return find(lookup(e, b, b.getField("VAR").getText()).type);
            if (b.type == "function_call_output") {
                return getReturnTypeOfFunctionCall(e, b);
            }
            if (!b.outputConnection) {
                return ground(pUnit.type);
            }
            const check = b.outputConnection.check_ && b.outputConnection.check_.length ? b.outputConnection.check_[0] : "T";
            if (check === "Array") {
                if (b.outputConnection.check_.length > 1) {
                    // HACK: The real type is stored as the second check
                    return ground(b.outputConnection.check_[1]);
                }
                // lists_create_with and argument_reporter_array both hit this.
                // For lists_create_with, we can safely infer the type from the
                // first input that has a return type.
                // For argument_reporter_array just return any[] for now
                let tp;
                if (b.type == "lists_create_with") {
                    if (b.inputList && b.inputList.length) {
                        for (const input of b.inputList) {
                            if (input.connection && input.connection.targetBlock()) {
                                let t = find(returnType(e, input.connection.targetBlock()));
                                if (t) {
                                    if (t.parentType) {
                                        return t.parentType;
                                    }
                                    tp = t.type ? ground(t.type + "[]") : mkPoint(null);
                                    genericLink(tp, t);
                                    break;
                                }
                            }
                        }
                    }
                }
                else if (b.type == "argument_reporter_array") {
                    if (!tp) {
                        tp = lookup(e, b, b.getFieldValue("VALUE")).type;
                    }
                }
                if (tp)
                    tp.isArrayType = true;
                return tp || mkPoint(null, true);
            }
            else if (check === "T") {
                const func = e.stdCallTable[b.type];
                const isArrayGet = b.type === "lists_index_get";
                if (isArrayGet || func && func.comp.thisParameter) {
                    let parentInput;
                    if (isArrayGet) {
                        parentInput = b.inputList.find(i => i.name === "LIST");
                    }
                    else {
                        parentInput = b.inputList.find(i => i.name === func.comp.thisParameter.definitionName);
                    }
                    if (parentInput.connection && parentInput.connection.targetBlock()) {
                        const parentType = returnType(e, parentInput.connection.targetBlock());
                        if (parentType.childType) {
                            return parentType.childType;
                        }
                        const p = isArrayType(parentType.type) && parentType.type !== "Array" ? mkPoint(parentType.type.substr(0, parentType.type.length - 2)) : mkPoint(null);
                        genericLink(parentType, p);
                        return p;
                    }
                }
                return mkPoint(null);
            }
            return ground(check);
        }
        function returnTypeWithInheritance(e, b) {
            var _a, _b;
            if (!((_b = (_a = b.outputConnection) === null || _a === void 0 ? void 0 : _a.check_) === null || _b === void 0 ? void 0 : _b.length) || b.outputConnection.check_[0] === "Array" || b.outputConnection.check_[0] === "T") {
                return [returnType(e, b)];
            }
            return b.outputConnection.check_.map(t => ground(t));
        }
        function getReturnTypeOfFunction(e, name) {
            if (!e.userFunctionReturnValues[name]) {
                const definition = Blockly.Functions.getDefinition(name, e.workspace);
                let res = mkPoint("void");
                if (isFunctionRecursive(definition, true)) {
                    res = mkPoint("any");
                }
                else {
                    const returnTypes = [];
                    for (const child of definition.getDescendants(false)) {
                        if (child.type === "function_return") {
                            attachPlaceholderIf(e, child, "RETURN_VALUE");
                            returnTypes.push(returnType(e, getInputTargetBlock(child, "RETURN_VALUE")));
                        }
                    }
                    if (returnTypes.length) {
                        try {
                            const unified = mkPoint(null);
                            for (const point of returnTypes) {
                                union(unified, point);
                            }
                            res = unified;
                        }
                        catch (err) {
                            e.diagnostics.push({
                                blockId: definition.id,
                                message: pxt.Util.lf("Function '{0}' has an invalid return type", name)
                            });
                            res = mkPoint("any");
                        }
                    }
                }
                e.userFunctionReturnValues[name] = res;
            }
            return e.userFunctionReturnValues[name];
        }
        function getReturnTypeOfFunctionCall(e, call) {
            const name = call.getField("function_name").getText();
            return getReturnTypeOfFunction(e, name);
        }
        // Basic type unification routine; easy, because there's no structural types.
        // FIXME: Generics are not supported
        function unify(t1, t2) {
            if (t1 == null || t1 === "Array" && isArrayType(t2))
                return t2;
            else if (t2 == null || t2 === "Array" && isArrayType(t1))
                return t1;
            else if (t1 == t2)
                return t1;
            else
                throw new Error("cannot mix " + t1 + " with " + t2);
        }
        function isArrayType(type) {
            return type && (type.indexOf("[]") !== -1 || type == "Array");
        }
        function mkPlaceholderBlock(e, parent, type) {
            // XXX define a proper placeholder block type
            return {
                type: "placeholder",
                p: mkPoint(type || null),
                workspace: e.workspace,
                parentBlock_: parent
            };
        }
        function attachPlaceholderIf(e, b, n, type) {
            // Ugly hack to keep track of the type we want there.
            const target = b.getInputTargetBlock(n);
            if (!target) {
                if (!placeholders[b.id]) {
                    placeholders[b.id] = {};
                }
                if (!placeholders[b.id][n]) {
                    placeholders[b.id][n] = mkPlaceholderBlock(e, b, type);
                }
            }
            else if (target.type === pxtc.TS_OUTPUT_TYPE && !(target.p)) {
                target.p = mkPoint(null);
            }
        }
        function getLoopVariableField(b) {
            return (b.type == "pxt_controls_for" || b.type == "pxt_controls_for_of") ?
                getInputTargetBlock(b, "VAR") : b;
        }
        function getInputTargetBlock(b, n) {
            const res = b.getInputTargetBlock(n);
            if (!res) {
                return placeholders[b.id] && placeholders[b.id][n];
            }
            else {
                return res;
            }
        }
        function removeAllPlaceholders() {
            placeholders = {};
        }
        // Unify the *return* type of the parameter [n] of block [b] with point [p].
        function unionParam(e, b, n, p) {
            attachPlaceholderIf(e, b, n);
            try {
                union(returnType(e, getInputTargetBlock(b, n)), p);
            }
            catch (e) {
                // TypeScript should catch this error and bubble it up
            }
        }
        function infer(allBlocks, e, w) {
            if (allBlocks)
                allBlocks.filter(b => b.isEnabled()).forEach((b) => {
                    try {
                        switch (b.type) {
                            case "math_op2":
                                unionParam(e, b, "x", ground(pNumber.type));
                                unionParam(e, b, "y", ground(pNumber.type));
                                break;
                            case "math_op3":
                                unionParam(e, b, "x", ground(pNumber.type));
                                break;
                            case "math_arithmetic":
                            case "logic_compare":
                                switch (b.getFieldValue("OP")) {
                                    case "ADD":
                                    case "MINUS":
                                    case "MULTIPLY":
                                    case "DIVIDE":
                                    case "LT":
                                    case "LTE":
                                    case "GT":
                                    case "GTE":
                                    case "POWER":
                                        unionParam(e, b, "A", ground(pNumber.type));
                                        unionParam(e, b, "B", ground(pNumber.type));
                                        break;
                                    case "AND":
                                    case "OR":
                                        attachPlaceholderIf(e, b, "A", pBoolean.type);
                                        attachPlaceholderIf(e, b, "B", pBoolean.type);
                                        break;
                                    case "EQ":
                                    case "NEQ":
                                        attachPlaceholderIf(e, b, "A");
                                        attachPlaceholderIf(e, b, "B");
                                        let p1 = returnType(e, getInputTargetBlock(b, "A"));
                                        let p2 = returnType(e, getInputTargetBlock(b, "B"));
                                        try {
                                            union(p1, p2);
                                        }
                                        catch (e) {
                                            // TypeScript should catch this error and bubble it up
                                        }
                                        break;
                                }
                                break;
                            case "logic_operation":
                                attachPlaceholderIf(e, b, "A", pBoolean.type);
                                attachPlaceholderIf(e, b, "B", pBoolean.type);
                                break;
                            case "logic_negate":
                                attachPlaceholderIf(e, b, "BOOL", pBoolean.type);
                                break;
                            case "controls_if":
                                for (let i = 0; i <= b.elseifCount_; ++i)
                                    attachPlaceholderIf(e, b, "IF" + i, pBoolean.type);
                                break;
                            case "pxt_controls_for":
                            case "controls_simple_for":
                                unionParam(e, b, "TO", ground(pNumber.type));
                                break;
                            case "pxt_controls_for_of":
                            case "controls_for_of":
                                const listTp = returnType(e, getInputTargetBlock(b, "LIST"));
                                const elementTp = lookup(e, b, getLoopVariableField(b).getField("VAR").getText()).type;
                                genericLink(listTp, elementTp);
                                break;
                            case "variables_set":
                            case "variables_change":
                                let p1 = lookup(e, b, b.getField("VAR").getText()).type;
                                attachPlaceholderIf(e, b, "VALUE");
                                let rhs = getInputTargetBlock(b, "VALUE");
                                if (rhs) {
                                    // Get the inheritance chain for this type and check to see if the existing
                                    // type shows up in it somewhere
                                    let tr = returnTypeWithInheritance(e, rhs);
                                    const t1 = find(p1);
                                    if (t1.type && tr.slice(1).some(p => p.type === t1.type)) {
                                        // If it does, we want to take the most narrow type (which will always be in 0)
                                        p1.link = find(tr[0]);
                                    }
                                    else {
                                        try {
                                            union(p1, tr[0]);
                                        }
                                        catch (e) {
                                            // TypeScript should catch this error and bubble it up
                                        }
                                    }
                                }
                                break;
                            case "controls_repeat_ext":
                                unionParam(e, b, "TIMES", ground(pNumber.type));
                                break;
                            case "device_while":
                                attachPlaceholderIf(e, b, "COND", pBoolean.type);
                                break;
                            case "lists_index_get":
                                unionParam(e, b, "LIST", ground("Array"));
                                unionParam(e, b, "INDEX", ground(pNumber.type));
                                const listType = returnType(e, getInputTargetBlock(b, "LIST"));
                                const ret = returnType(e, b);
                                genericLink(listType, ret);
                                break;
                            case "lists_index_set":
                                unionParam(e, b, "LIST", ground("Array"));
                                attachPlaceholderIf(e, b, "VALUE");
                                handleGenericType(b, "LIST");
                                unionParam(e, b, "INDEX", ground(pNumber.type));
                                break;
                            case 'function_definition':
                                getReturnTypeOfFunction(e, b.getField("function_name").getText());
                                break;
                            case 'function_call':
                            case 'function_call_output':
                                b.getArguments().forEach(arg => {
                                    unionParam(e, b, arg.id, ground(arg.type));
                                });
                                break;
                            case pxtc.TS_RETURN_STATEMENT_TYPE:
                                attachPlaceholderIf(e, b, "RETURN_VALUE");
                                break;
                            case pxtc.PAUSE_UNTIL_TYPE:
                                unionParam(e, b, "PREDICATE", pBoolean);
                                break;
                            default:
                                if (b.type in e.stdCallTable) {
                                    const call = e.stdCallTable[b.type];
                                    if (call.attrs.shim === "ENUM_GET" || call.attrs.shim === "KIND_GET")
                                        return;
                                    visibleParams(call, countOptionals(b, call)).forEach((p, i) => {
                                        const isInstance = call.isExtensionMethod && i === 0;
                                        if (p.definitionName && !b.getFieldValue(p.definitionName)) {
                                            let i = b.inputList.find((i) => i.name == p.definitionName);
                                            if (i && i.connection && i.connection.check_) {
                                                if (isInstance && connectionCheck(i) === "Array") {
                                                    let gen = handleGenericType(b, p.definitionName);
                                                    if (gen) {
                                                        return;
                                                    }
                                                }
                                                // All of our injected blocks have single output checks, but the builtin
                                                // blockly ones like string.length and array.length might have multiple
                                                for (let j = 0; j < i.connection.check_.length; j++) {
                                                    try {
                                                        let t = i.connection.check_[j];
                                                        unionParam(e, b, p.definitionName, ground(t));
                                                        break;
                                                    }
                                                    catch (e) {
                                                        // Ignore type checking errors in the blocks...
                                                    }
                                                }
                                            }
                                        }
                                    });
                                }
                        }
                    }
                    catch (err) {
                        const be = err.block || b;
                        be.setWarningText(err + "");
                        e.errors.push(be);
                    }
                });
            // Last pass: if some variable has no type (because it was never used or
            // assigned to), just unify it with int...
            e.allVariables.forEach((v) => {
                if (getConcreteType(v.type).type == null) {
                    if (!v.isFunctionParameter) {
                        union(v.type, ground(v.type.isArrayType ? "number[]" : pNumber.type));
                    }
                    else if (v.type.isArrayType) {
                        v.type.type = "any[]";
                    }
                }
            });
            function connectionCheck(i) {
                return i.name ? i.connection && i.connection.check_ && i.connection.check_.length ? i.connection.check_[0] : "T" : undefined;
            }
            function handleGenericType(b, name) {
                let genericArgs = b.inputList.filter((input) => connectionCheck(input) === "T");
                if (genericArgs.length) {
                    const gen = getInputTargetBlock(b, genericArgs[0].name);
                    if (gen) {
                        const arg = returnType(e, gen);
                        const arrayType = arg.type ? ground(returnType(e, gen).type + "[]") : ground(null);
                        genericLink(arrayType, arg);
                        unionParam(e, b, name, arrayType);
                        return true;
                    }
                }
                return false;
            }
        }
        function genericLink(parent, child) {
            const p = find(parent);
            const c = find(child);
            if (p.childType) {
                union(p.childType, c);
            }
            else if (!p.type) {
                p.childType = c;
            }
            if (c.parentType) {
                union(c.parentType, p);
            }
            else if (!c.type) {
                c.parentType = p;
            }
            if (isArrayType(p.type))
                p.isArrayType = true;
        }
        function getConcreteType(point, found = []) {
            const t = find(point);
            if (found.indexOf(t) === -1) {
                found.push(t);
                if (!t.type || t.type === "Array") {
                    if (t.parentType) {
                        const parent = getConcreteType(t.parentType, found);
                        if (parent.type && parent.type !== "Array") {
                            if (isArrayType(parent.type)) {
                                t.type = parent.type.substr(0, parent.type.length - 2);
                            }
                            else {
                                t.type = parent.type;
                            }
                            return t;
                        }
                    }
                    if (t.childType) {
                        const child = getConcreteType(t.childType, found);
                        if (child.type) {
                            t.type = child.type + "[]";
                            return t;
                        }
                    }
                }
            }
            return t;
        }
        ///////////////////////////////////////////////////////////////////////////////
        // Expressions
        //
        // Expressions are now directly compiled as a tree. This requires knowing, for
        // each property ref, the right value for its [parent] property.
        ///////////////////////////////////////////////////////////////////////////////
        function extractNumber(b) {
            let v = b.getFieldValue(b.type === "math_number_minmax" ? "SLIDER" : "NUM");
            const parsed = parseFloat(v);
            checkNumber(parsed, b);
            return parsed;
        }
        function checkNumber(n, b) {
            if (!isFinite(n) || isNaN(n)) {
                throwBlockError(lf("Number entered is either too large or too small"), b);
            }
        }
        function extractTsExpression(e, b, comments) {
            return blocks_1.mkText(b.getFieldValue("EXPRESSION").trim());
        }
        function compileNumber(e, b, comments) {
            return blocks_1.H.mkNumberLiteral(extractNumber(b));
        }
        function isNumericLiteral(e, b) {
            if (!b)
                return false;
            if (b.type === "math_number" || b.type === "math_integer" || b.type === "math_number_minmax" || b.type === "math_whole_number") {
                return true;
            }
            const blockInfo = e.stdCallTable[b.type];
            if (!blockInfo)
                return false;
            const { comp } = blockInfo;
            if (blockInfo.attrs.shim === "TD_ID" && comp.parameters.length === 1) {
                const fieldValue = b.getFieldValue(comp.parameters[0].definitionName);
                if (fieldValue) {
                    return !isNaN(parseInt(fieldValue));
                }
                else {
                    return isNumericLiteral(e, getInputTargetBlock(b, comp.parameters[0].definitionName));
                }
            }
            return false;
        }
        function isLiteral(e, b) {
            return isNumericLiteral(e, b) || b.type === "logic_boolean" || b.type === "text";
        }
        let opToTok = {
            "ADD": "+",
            "MINUS": "-",
            "MULTIPLY": "*",
            "DIVIDE": "/",
            "LT": "<",
            "LTE": "<=",
            "GT": ">",
            "GTE": ">=",
            "AND": "&&",
            "OR": "||",
            "EQ": "==",
            "NEQ": "!=",
            "POWER": "**"
        };
        function isComparisonOp(op) {
            return ["LT", "LTE", "GT", "GTE", "EQ", "NEQ"].indexOf(op) !== -1;
        }
        function compileArithmetic(e, b, comments) {
            let bOp = b.getFieldValue("OP");
            let left = getInputTargetBlock(b, "A");
            let right = getInputTargetBlock(b, "B");
            let args = [compileExpression(e, left, comments), compileExpression(e, right, comments)];
            // Special handling for the case of comparing two literals (e.g. 0 === 5). TypeScript
            // throws an error if we don't first cast to any
            if (isComparisonOp(bOp) && isLiteral(e, left) && isLiteral(e, right)) {
                if (blocks_1.flattenNode([args[0]]).output !== blocks_1.flattenNode([args[1]]).output) {
                    args = args.map(arg => blocks_1.H.mkParenthesizedExpression(blocks_1.mkGroup([arg, blocks_1.mkText(" as any")])));
                }
            }
            let t = returnType(e, left).type;
            if (t == pString.type) {
                if (bOp == "EQ")
                    return blocks_1.H.mkSimpleCall("==", args);
                else if (bOp == "NEQ")
                    return blocks_1.H.mkSimpleCall("!=", args);
            }
            else if (t == pBoolean.type)
                return blocks_1.H.mkSimpleCall(opToTok[bOp], args);
            // Compilation of math operators.
            assert(bOp in opToTok);
            return blocks_1.H.mkSimpleCall(opToTok[bOp], args);
        }
        function compileModulo(e, b, comments) {
            let left = getInputTargetBlock(b, "DIVIDEND");
            let right = getInputTargetBlock(b, "DIVISOR");
            let args = [compileExpression(e, left, comments), compileExpression(e, right, comments)];
            return blocks_1.H.mkSimpleCall("%", args);
        }
        function compileMathOp2(e, b, comments) {
            let op = b.getFieldValue("op");
            let x = compileExpression(e, getInputTargetBlock(b, "x"), comments);
            let y = compileExpression(e, getInputTargetBlock(b, "y"), comments);
            return blocks_1.H.mathCall(op, [x, y]);
        }
        function compileMathOp3(e, b, comments) {
            let x = compileExpression(e, getInputTargetBlock(b, "x"), comments);
            return blocks_1.H.mathCall("abs", [x]);
        }
        function compileText(e, b, comments) {
            return blocks_1.H.mkStringLiteral(b.getFieldValue("TEXT"));
        }
        function compileTextJoin(e, b, comments) {
            let last;
            let i = 0;
            while (true) {
                const val = getInputTargetBlock(b, "ADD" + i);
                i++;
                if (!val) {
                    if (i < b.inputList.length) {
                        continue;
                    }
                    else {
                        break;
                    }
                }
                const compiled = compileExpression(e, val, comments);
                if (!last) {
                    if (val.type.indexOf("text") === 0) {
                        last = compiled;
                    }
                    else {
                        // If we don't start with a string, then the TS won't match
                        // the implied semantics of the blocks
                        last = blocks_1.H.mkSimpleCall("+", [blocks_1.H.mkStringLiteral(""), compiled]);
                    }
                }
                else {
                    last = blocks_1.H.mkSimpleCall("+", [last, compiled]);
                }
            }
            if (!last) {
                return blocks_1.H.mkStringLiteral("");
            }
            return last;
        }
        function compileBoolean(e, b, comments) {
            return blocks_1.H.mkBooleanLiteral(b.getFieldValue("BOOL") == "TRUE");
        }
        function compileNot(e, b, comments) {
            let expr = compileExpression(e, getInputTargetBlock(b, "BOOL"), comments);
            return blocks_1.mkPrefix("!", [blocks_1.H.mkParenthesizedExpression(expr)]);
        }
        function compileCreateList(e, b, comments) {
            // collect argument
            let args = b.inputList.map(input => input.connection && input.connection.targetBlock() ? compileExpression(e, input.connection.targetBlock(), comments) : undefined)
                .filter(e => !!e);
            return blocks_1.H.mkArrayLiteral(args, !b.getInputsInline());
        }
        function compileListGet(e, b, comments) {
            const listBlock = getInputTargetBlock(b, "LIST");
            const listExpr = compileExpression(e, listBlock, comments);
            const index = compileExpression(e, getInputTargetBlock(b, "INDEX"), comments);
            const res = blocks_1.mkGroup([listExpr, blocks_1.mkText("["), index, blocks_1.mkText("]")]);
            return res;
        }
        function compileListSet(e, b, comments) {
            const listBlock = getInputTargetBlock(b, "LIST");
            const listExpr = compileExpression(e, listBlock, comments);
            const index = compileExpression(e, getInputTargetBlock(b, "INDEX"), comments);
            const value = compileExpression(e, getInputTargetBlock(b, "VALUE"), comments);
            const res = blocks_1.mkGroup([listExpr, blocks_1.mkText("["), index, blocks_1.mkText("] = "), value]);
            return listBlock.type === "lists_create_with" ? prefixWithSemicolon(res) : res;
        }
        function compileMathJsOp(e, b, comments) {
            const op = b.getFieldValue("OP");
            const args = [compileExpression(e, getInputTargetBlock(b, "ARG0"), comments)];
            if (b.getInput("ARG1")) {
                args.push(compileExpression(e, getInputTargetBlock(b, "ARG1"), comments));
            }
            return blocks_1.H.mathCall(op, args);
        }
        function compileFunctionDefinition(e, b, comments) {
            const name = escapeVarName(b.getField("function_name").getText(), e, true);
            const stmts = getInputTargetBlock(b, "STACK");
            const argsDeclaration = b.getArguments().map(a => {
                if (a.type == "Array") {
                    const binding = lookup(e, b, a.name);
                    const declaredType = getConcreteType(binding.type);
                    const paramType = ((declaredType === null || declaredType === void 0 ? void 0 : declaredType.type) && declaredType.type !== "Array") ? declaredType.type : "any[]";
                    return `${escapeVarName(a.name, e)}: ${paramType}`;
                }
                return `${escapeVarName(a.name, e)}: ${a.type}`;
            });
            const isRecursive = isFunctionRecursive(b, false);
            return [
                blocks_1.mkText(`function ${name} (${argsDeclaration.join(", ")})${isRecursive ? ": any" : ""}`),
                compileStatements(e, stmts)
            ];
        }
        function compileProcedure(e, b, comments) {
            const name = escapeVarName(b.getFieldValue("NAME"), e, true);
            const stmts = getInputTargetBlock(b, "STACK");
            return [
                blocks_1.mkText("function " + name + "() "),
                compileStatements(e, stmts)
            ];
        }
        function compileProcedureCall(e, b, comments) {
            const name = escapeVarName(b.getFieldValue("NAME"), e, true);
            return blocks_1.mkStmt(blocks_1.mkText(name + "()"));
        }
        function compileFunctionCall(e, b, comments, statement) {
            const name = escapeVarName(b.getField("function_name").getText(), e, true);
            const externalInputs = !b.getInputsInline();
            const args = b.getArguments().map(a => {
                return {
                    actualName: a.name,
                    definitionName: a.id
                };
            });
            const compiledArgs = args.map(a => compileArgument(e, b, a, comments));
            const res = blocks_1.H.stdCall(name, compiledArgs, externalInputs);
            if (statement) {
                return blocks_1.mkStmt(res);
            }
            return res;
        }
        function compileReturnStatement(e, b, comments) {
            const expression = getInputTargetBlock(b, "RETURN_VALUE");
            if (expression && expression.type != "placeholder") {
                return blocks_1.mkStmt(blocks_1.mkText("return "), compileExpression(e, expression, comments));
            }
            else {
                return blocks_1.mkStmt(blocks_1.mkText("return"));
            }
        }
        function compileArgumentReporter(e, b, comments) {
            const name = escapeVarName(b.getFieldValue("VALUE"), e);
            return blocks_1.mkText(name);
        }
        function compileWorkspaceComment(c) {
            const content = c.getContent();
            return blocks_1.Helpers.mkMultiComment(content.trim());
        }
        function defaultValueForType(t) {
            if (t.type == null) {
                union(t, ground(pNumber.type));
                t = find(t);
            }
            if (isArrayType(t.type) || t.isArrayType) {
                return blocks_1.mkText("[]");
            }
            switch (t.type) {
                case "boolean":
                    return blocks_1.H.mkBooleanLiteral(false);
                case "number":
                    return blocks_1.H.mkNumberLiteral(0);
                case "string":
                    return blocks_1.H.mkStringLiteral("");
                default:
                    return blocks_1.mkText("null");
            }
        }
        // [t] is the expected type; we assume that we never null block children
        // (because placeholder blocks have been inserted by the type-checking phase
        // whenever a block was actually missing).
        function compileExpression(e, b, comments) {
            assert(b != null);
            e.stats[b.type] = (e.stats[b.type] || 0) + 1;
            maybeAddComment(b, comments);
            let expr;
            if (b.type == "placeholder" || !(b.isEnabled && b.isEnabled())) {
                const ret = find(returnType(e, b));
                if (ret.type === "Array") {
                    // FIXME: Can't use default type here because TS complains about
                    // the array having an implicit any type. However, forcing this
                    // to be a number array may cause type issues. Also, potential semicolon
                    // issues if we ever have a block where the array is not the first argument...
                    let isExpression = b.parentBlock_.type === "lists_index_get";
                    if (!isExpression) {
                        const call = e.stdCallTable[b.parentBlock_.type];
                        isExpression = call && call.isExpression;
                    }
                    const arrayNode = blocks_1.mkText("[0]");
                    expr = isExpression ? arrayNode : prefixWithSemicolon(arrayNode);
                }
                else {
                    expr = defaultValueForType(returnType(e, b));
                }
            }
            else
                switch (b.type) {
                    case "math_number":
                    case "math_integer":
                    case "math_whole_number":
                        expr = compileNumber(e, b, comments);
                        break;
                    case "math_number_minmax":
                        expr = compileNumber(e, b, comments);
                        break;
                    case "math_op2":
                        expr = compileMathOp2(e, b, comments);
                        break;
                    case "math_op3":
                        expr = compileMathOp3(e, b, comments);
                        break;
                    case "math_arithmetic":
                    case "logic_compare":
                    case "logic_operation":
                        expr = compileArithmetic(e, b, comments);
                        break;
                    case "math_modulo":
                        expr = compileModulo(e, b, comments);
                        break;
                    case "logic_boolean":
                        expr = compileBoolean(e, b, comments);
                        break;
                    case "logic_negate":
                        expr = compileNot(e, b, comments);
                        break;
                    case "variables_get":
                        expr = compileVariableGet(e, b);
                        break;
                    case "text":
                        expr = compileText(e, b, comments);
                        break;
                    case "text_join":
                        expr = compileTextJoin(e, b, comments);
                        break;
                    case "lists_create_with":
                        expr = compileCreateList(e, b, comments);
                        break;
                    case "lists_index_get":
                        expr = compileListGet(e, b, comments);
                        break;
                    case "lists_index_set":
                        expr = compileListSet(e, b, comments);
                        break;
                    case "math_js_op":
                    case "math_js_round":
                        expr = compileMathJsOp(e, b, comments);
                        break;
                    case pxtc.TS_OUTPUT_TYPE:
                        expr = extractTsExpression(e, b, comments);
                        break;
                    case "argument_reporter_boolean":
                    case "argument_reporter_number":
                    case "argument_reporter_string":
                    case "argument_reporter_array":
                    case "argument_reporter_custom":
                        expr = compileArgumentReporter(e, b, comments);
                        break;
                    case "function_call_output":
                        expr = compileFunctionCall(e, b, comments, false);
                        break;
                    default:
                        let call = e.stdCallTable[b.type];
                        if (call) {
                            if (call.imageLiteral)
                                expr = compileImage(e, b, call.imageLiteral, call.imageLiteralColumns, call.imageLiteralRows, call.namespace, call.f, visibleParams(call, countOptionals(b, call)).map(ar => compileArgument(e, b, ar, comments)));
                            else
                                expr = compileStdCall(e, b, call, comments);
                        }
                        else {
                            pxt.reportError("blocks", "unable to compile expression", { "details": b.type });
                            expr = defaultValueForType(returnType(e, b));
                        }
                        break;
                }
            expr.id = b.id;
            return expr;
        }
        blocks_1.compileExpression = compileExpression;
        function lookup(e, b, name) {
            return getVarInfo(name, e.idToScope[b.id]);
        }
        function emptyEnv(w, options) {
            return {
                workspace: w,
                options,
                stdCallTable: {},
                userFunctionReturnValues: {},
                diagnostics: [],
                errors: [],
                renames: {
                    oldToNew: {},
                    takenNames: {},
                    oldToNewFunctions: {}
                },
                stats: {},
                enums: [],
                kinds: [],
                idToScope: {},
                blockDeclarations: {},
                allVariables: [],
                blocksInfo: null
            };
        }
        ;
        ///////////////////////////////////////////////////////////////////////////////
        // Statements
        ///////////////////////////////////////////////////////////////////////////////
        function compileControlsIf(e, b, comments) {
            let stmts = [];
            // Notice the <= (if there's no else-if, we still compile the primary if).
            for (let i = 0; i <= b.elseifCount_; ++i) {
                let cond = compileExpression(e, getInputTargetBlock(b, "IF" + i), comments);
                let thenBranch = compileStatements(e, getInputTargetBlock(b, "DO" + i));
                let startNode = blocks_1.mkText("if (");
                if (i > 0) {
                    startNode = blocks_1.mkText("else if (");
                    startNode.glueToBlock = blocks_1.GlueMode.WithSpace;
                }
                append(stmts, [
                    startNode,
                    cond,
                    blocks_1.mkText(")"),
                    thenBranch
                ]);
            }
            if (b.elseCount_) {
                let elseNode = blocks_1.mkText("else");
                elseNode.glueToBlock = blocks_1.GlueMode.WithSpace;
                append(stmts, [
                    elseNode,
                    compileStatements(e, getInputTargetBlock(b, "ELSE"))
                ]);
            }
            return stmts;
        }
        function compileControlsFor(e, b, comments) {
            let bTo = getInputTargetBlock(b, "TO");
            let bDo = getInputTargetBlock(b, "DO");
            let bBy = getInputTargetBlock(b, "BY");
            let bFrom = getInputTargetBlock(b, "FROM");
            let incOne = !bBy || (bBy.type.match(/^math_number/) && extractNumber(bBy) == 1);
            let binding = lookup(e, b, getLoopVariableField(b).getField("VAR").getText());
            return [
                blocks_1.mkText("for (let " + binding.escapedName + " = "),
                bFrom ? compileExpression(e, bFrom, comments) : blocks_1.mkText("0"),
                blocks_1.mkText("; "),
                blocks_1.mkInfix(blocks_1.mkText(binding.escapedName), "<=", compileExpression(e, bTo, comments)),
                blocks_1.mkText("; "),
                incOne ? blocks_1.mkText(binding.escapedName + "++") : blocks_1.mkInfix(blocks_1.mkText(binding.escapedName), "+=", compileExpression(e, bBy, comments)),
                blocks_1.mkText(")"),
                compileStatements(e, bDo)
            ];
        }
        function compileControlsRepeat(e, b, comments) {
            let bound = compileExpression(e, getInputTargetBlock(b, "TIMES"), comments);
            let body = compileStatements(e, getInputTargetBlock(b, "DO"));
            let valid = (x) => !lookup(e, b, x);
            let name = "index";
            // Start at 2 because index0 and index1 are bad names
            for (let i = 2; !valid(name); i++)
                name = "index" + i;
            return [
                blocks_1.mkText("for (let " + name + " = 0; "),
                blocks_1.mkInfix(blocks_1.mkText(name), "<", bound),
                blocks_1.mkText("; " + name + "++)"),
                body
            ];
        }
        function compileWhile(e, b, comments) {
            let cond = compileExpression(e, getInputTargetBlock(b, "COND"), comments);
            let body = compileStatements(e, getInputTargetBlock(b, "DO"));
            return [
                blocks_1.mkText("while ("),
                cond,
                blocks_1.mkText(")"),
                body
            ];
        }
        function compileControlsForOf(e, b, comments) {
            let bOf = getInputTargetBlock(b, "LIST");
            let bDo = getInputTargetBlock(b, "DO");
            let binding = lookup(e, b, getLoopVariableField(b).getField("VAR").getText());
            return [
                blocks_1.mkText("for (let " + binding.escapedName + " of "),
                compileExpression(e, bOf, comments),
                blocks_1.mkText(")"),
                compileStatements(e, bDo)
            ];
        }
        function compileForever(e, b) {
            let bBody = getInputTargetBlock(b, "HANDLER");
            let body = compileStatements(e, bBody);
            return mkCallWithCallback(e, "basic", "forever", [], body);
        }
        // convert to javascript friendly name
        function escapeVarName(name, e, isFunction = false) {
            if (!name)
                return '_';
            if (isFunction) {
                if (e.renames.oldToNewFunctions[name]) {
                    return e.renames.oldToNewFunctions[name];
                }
            }
            else if (e.renames.oldToNew[name]) {
                return e.renames.oldToNew[name];
            }
            let n = ts.pxtc.escapeIdentifier(name);
            if (e.renames.takenNames[n]) {
                let i = 2;
                while (e.renames.takenNames[n + i]) {
                    i++;
                }
                n += i;
            }
            if (isFunction) {
                e.renames.oldToNewFunctions[name] = n;
                e.renames.takenNames[n] = true;
            }
            else {
                e.renames.oldToNew[name] = n;
            }
            return n;
        }
        blocks_1.escapeVarName = escapeVarName;
        function compileVariableGet(e, b) {
            const name = b.getField("VAR").getText();
            let binding = lookup(e, b, name);
            if (!binding) // trying to compile a disabled block with a bogus variable
                return blocks_1.mkText(name);
            if (!binding.firstReference)
                binding.firstReference = b;
            assert(binding != null && binding.type != null);
            return blocks_1.mkText(binding.escapedName);
        }
        function compileSet(e, b, comments) {
            let bExpr = getInputTargetBlock(b, "VALUE");
            let binding = lookup(e, b, b.getField("VAR").getText());
            const currentScope = e.idToScope[b.id];
            let isDef = currentScope.declaredVars[binding.name] === binding && !binding.firstReference && !binding.alreadyDeclared;
            if (isDef) {
                // Check the expression of the set block to determine if it references itself and needs
                // to be hoisted
                forEachChildExpression(b, child => {
                    if (child.type === "variables_get") {
                        let childBinding = lookup(e, child, child.getField("VAR").getText());
                        if (childBinding === binding)
                            isDef = false;
                    }
                }, true);
            }
            let expr = compileExpression(e, bExpr, comments);
            let bindString = binding.escapedName + " = ";
            binding.isAssigned = true;
            if (isDef) {
                binding.alreadyDeclared = BlockDeclarationType.Assigned;
                const declaredType = getConcreteType(binding.type);
                bindString = `let ${binding.escapedName} = `;
                if (declaredType) {
                    const expressionType = getConcreteType(returnType(e, bExpr));
                    if (declaredType.type !== expressionType.type) {
                        bindString = `let ${binding.escapedName}: ${declaredType.type} = `;
                    }
                }
            }
            else if (!binding.firstReference) {
                binding.firstReference = b;
            }
            return blocks_1.mkStmt(blocks_1.mkText(bindString), expr);
        }
        function compileChange(e, b, comments) {
            let bExpr = getInputTargetBlock(b, "VALUE");
            let binding = lookup(e, b, b.getField("VAR").getText());
            let expr = compileExpression(e, bExpr, comments);
            let ref = blocks_1.mkText(binding.escapedName);
            return blocks_1.mkStmt(blocks_1.mkInfix(ref, "+=", expr));
        }
        function eventArgs(call, b) {
            return visibleParams(call, countOptionals(b, call)).filter(ar => !!ar.definitionName);
        }
        function compileCall(e, b, comments) {
            const call = e.stdCallTable[b.type];
            if (call.imageLiteral)
                return blocks_1.mkStmt(compileImage(e, b, call.imageLiteral, call.imageLiteralColumns, call.imageLiteralRows, call.namespace, call.f, visibleParams(call, countOptionals(b, call)).map(ar => compileArgument(e, b, ar, comments))));
            else if (call.hasHandler)
                return compileEvent(e, b, call, eventArgs(call, b), call.namespace, comments);
            else
                return blocks_1.mkStmt(compileStdCall(e, b, call, comments));
        }
        function compileArgument(e, b, p, comments, beginningOfStatement = false) {
            let f = b.getFieldValue(p.definitionName);
            if (f != null) {
                const field = b.getField(p.definitionName);
                if (field instanceof pxtblockly.FieldTextInput) {
                    return blocks_1.H.mkStringLiteral(f);
                }
                else if (field instanceof pxtblockly.FieldTilemap && !field.isGreyBlock) {
                    const project = pxt.react.getTilemapProject();
                    const tmString = field.getValue();
                    if (tmString.startsWith("tilemap`")) {
                        return blocks_1.mkText(tmString);
                    }
                    if (e.options.emitTilemapLiterals) {
                        try {
                            const data = pxt.sprite.decodeTilemap(tmString, "typescript", project);
                            if (data) {
                                const [name] = project.createNewTilemapFromData(data);
                                return blocks_1.mkText(`tilemap\`${name}\``);
                            }
                        }
                        catch (e) {
                            // This is a legacy tilemap or a grey block, ignore the exception
                            // and compile as a normal field
                        }
                    }
                }
                // For some enums in pxt-minecraft, we emit the members as constants that are defined in
                // libs/core. For example, Blocks.GoldBlock is emitted as GOLD_BLOCK
                const type = e.blocksInfo.apis.byQName[p.type];
                if (type && type.attributes.emitAsConstant) {
                    for (const symbolName of Object.keys(e.blocksInfo.apis.byQName)) {
                        const symbol = e.blocksInfo.apis.byQName[symbolName];
                        if (symbol && symbol.attributes && symbol.attributes.enumIdentity === f) {
                            return blocks_1.mkText(symbolName);
                        }
                    }
                }
                let text = blocks_1.mkText(f);
                text.canIndentInside = typeof f == "string" && f.indexOf('\n') >= 0;
                return text;
            }
            else {
                attachPlaceholderIf(e, b, p.definitionName);
                const target = getInputTargetBlock(b, p.definitionName);
                if (beginningOfStatement && target.type === "lists_create_with") {
                    // We have to be careful of array literals at the beginning of a statement
                    // because they can cause errors (i.e. they get parsed as an index). Add a
                    // semicolon to the previous statement just in case.
                    // FIXME: No need to do this if the previous statement was a code block
                    return prefixWithSemicolon(compileExpression(e, target, comments));
                }
                if (p.shadowOptions && p.shadowOptions.toString && returnType(e, target) !== pString) {
                    return blocks_1.H.mkSimpleCall("+", [blocks_1.H.mkStringLiteral(""), blocks_1.H.mkParenthesizedExpression(compileExpression(e, target, comments))]);
                }
                return compileExpression(e, target, comments);
            }
        }
        function compileStdCall(e, b, func, comments) {
            let args;
            if (isMutatingBlock(b) && b.mutation.getMutationType() === blocks_1.MutatorTypes.RestParameterMutator) {
                args = b.mutation.compileMutation(e, comments).children;
            }
            else if (func.attrs.shim === "ENUM_GET") {
                const enumName = func.attrs.enumName;
                const enumMember = b.getFieldValue("MEMBER").replace(/^\d+/, "");
                return blocks_1.H.mkPropertyAccess(enumMember, blocks_1.mkText(enumName));
            }
            else if (func.attrs.shim === "KIND_GET") {
                const info = e.kinds.filter(k => k.blockId === func.attrs.blockId)[0];
                return blocks_1.H.mkPropertyAccess(b.getFieldValue("MEMBER"), blocks_1.mkText(info.name));
            }
            else {
                args = visibleParams(func, countOptionals(b, func)).map((p, i) => compileArgument(e, b, p, comments, func.isExtensionMethod && i === 0 && !func.isExpression));
            }
            let callNamespace = func.namespace;
            let callName = func.f;
            if (func.attrs.blockAliasFor) {
                const aliased = e.blocksInfo.apis.byQName[func.attrs.blockAliasFor];
                if (aliased) {
                    callName = aliased.name;
                    callNamespace = aliased.namespace;
                }
            }
            const externalInputs = !b.getInputsInline();
            if (func.isIdentity)
                return args[0];
            else if (func.property) {
                return blocks_1.H.mkPropertyAccess(callName, args[0]);
            }
            else if (callName == "@get@") {
                return blocks_1.H.mkPropertyAccess(args[1].op.replace(/.*\./, ""), args[0]);
            }
            else if (callName == "@set@") {
                return blocks_1.H.mkAssign(blocks_1.H.mkPropertyAccess(args[1].op.replace(/.*\./, "").replace(/@set/, ""), args[0]), args[2]);
            }
            else if (callName == "@change@") {
                return blocks_1.H.mkSimpleCall("+=", [blocks_1.H.mkPropertyAccess(args[1].op.replace(/.*\./, "").replace(/@set/, ""), args[0]), args[2]]);
            }
            else if (func.isExtensionMethod) {
                if (func.attrs.defaultInstance) {
                    let instance;
                    if (isMutatingBlock(b) && b.mutation.getMutationType() === blocks_1.MutatorTypes.DefaultInstanceMutator) {
                        instance = b.mutation.compileMutation(e, comments);
                    }
                    if (instance) {
                        args.unshift(instance);
                    }
                    else {
                        args.unshift(blocks_1.mkText(func.attrs.defaultInstance));
                    }
                }
                return blocks_1.H.extensionCall(callName, args, externalInputs);
            }
            else if (callNamespace) {
                return blocks_1.H.namespaceCall(callNamespace, callName, args, externalInputs);
            }
            else {
                return blocks_1.H.stdCall(callName, args, externalInputs);
            }
        }
        function compileStdBlock(e, b, f, comments) {
            return blocks_1.mkStmt(compileStdCall(e, b, f, comments));
        }
        function mkCallWithCallback(e, n, f, args, body, argumentDeclaration, isExtension = false) {
            body.noFinalNewline = true;
            let callback;
            if (argumentDeclaration) {
                callback = blocks_1.mkGroup([argumentDeclaration, body]);
            }
            else {
                callback = blocks_1.mkGroup([blocks_1.mkText("function ()"), body]);
            }
            if (isExtension)
                return blocks_1.mkStmt(blocks_1.H.extensionCall(f, args.concat([callback]), false));
            else if (n)
                return blocks_1.mkStmt(blocks_1.H.namespaceCall(n, f, args.concat([callback]), false));
            else
                return blocks_1.mkStmt(blocks_1.H.mkCall(f, args.concat([callback]), false));
        }
        function compileStartEvent(e, b) {
            const bBody = getInputTargetBlock(b, "HANDLER");
            const body = compileStatements(e, bBody);
            if (pxt.appTarget.compile && pxt.appTarget.compile.onStartText && body && body.children) {
                body.children.unshift(blocks_1.mkStmt(blocks_1.mkText(`// ${pxtc.ON_START_COMMENT}\n`)));
            }
            return body;
        }
        function compileEvent(e, b, stdfun, args, ns, comments) {
            const compiledArgs = args.map(arg => compileArgument(e, b, arg, comments));
            const bBody = getInputTargetBlock(b, "HANDLER");
            const body = compileStatements(e, bBody);
            if (pxt.appTarget.compile && pxt.appTarget.compile.emptyEventHandlerComments && body.children.length === 0) {
                body.children.unshift(blocks_1.mkStmt(blocks_1.mkText(`// ${pxtc.HANDLER_COMMENT}`)));
            }
            let argumentDeclaration;
            if (isMutatingBlock(b) && b.mutation.getMutationType() === blocks_1.MutatorTypes.ObjectDestructuringMutator) {
                argumentDeclaration = b.mutation.compileMutation(e, comments);
            }
            else if (stdfun.comp.handlerArgs.length) {
                let handlerArgs = getEscapedCBParameters(b, stdfun, e);
                argumentDeclaration = blocks_1.mkText(`function (${handlerArgs.join(", ")})`);
            }
            return mkCallWithCallback(e, ns, stdfun.f, compiledArgs, body, argumentDeclaration, stdfun.isExtensionMethod);
        }
        function isMutatingBlock(b) {
            return !!b.mutation;
        }
        function compileImage(e, b, frames, columns, rows, n, f, args) {
            args = args === undefined ? [] : args;
            let state = "\n";
            rows = rows || 5;
            columns = (columns || 5) * frames;
            let leds = b.getFieldValue("LEDS");
            leds = leds.replace(/[ `\n]+/g, '');
            for (let i = 0; i < rows; ++i) {
                for (let j = 0; j < columns; ++j) {
                    if (j > 0)
                        state += ' ';
                    state += (leds[(i * columns) + j] === '#') ? "#" : ".";
                }
                state += '\n';
            }
            let lit = blocks_1.H.mkStringLiteral(state);
            lit.canIndentInside = true;
            return blocks_1.H.namespaceCall(n, f, [lit].concat(args), false);
        }
        function compileStatementBlock(e, b) {
            let r;
            const comments = [];
            e.stats[b.type] = (e.stats[b.type] || 0) + 1;
            maybeAddComment(b, comments);
            switch (b.type) {
                case 'controls_if':
                    r = compileControlsIf(e, b, comments);
                    break;
                case 'pxt_controls_for':
                case 'controls_for':
                case 'controls_simple_for':
                    r = compileControlsFor(e, b, comments);
                    break;
                case 'pxt_controls_for_of':
                case 'controls_for_of':
                    r = compileControlsForOf(e, b, comments);
                    break;
                case 'variables_set':
                    r = [compileSet(e, b, comments)];
                    break;
                case 'variables_change':
                    r = [compileChange(e, b, comments)];
                    break;
                case 'controls_repeat_ext':
                    r = compileControlsRepeat(e, b, comments);
                    break;
                case 'device_while':
                    r = compileWhile(e, b, comments);
                    break;
                case 'procedures_defnoreturn':
                    r = compileProcedure(e, b, comments);
                    break;
                case 'function_definition':
                    r = compileFunctionDefinition(e, b, comments);
                    break;
                case 'procedures_callnoreturn':
                    r = [compileProcedureCall(e, b, comments)];
                    break;
                case 'function_call':
                    r = [compileFunctionCall(e, b, comments, true)];
                    break;
                case pxtc.TS_RETURN_STATEMENT_TYPE:
                    r = [compileReturnStatement(e, b, comments)];
                    break;
                case ts.pxtc.ON_START_TYPE:
                    r = compileStartEvent(e, b).children;
                    break;
                case pxtc.TS_STATEMENT_TYPE:
                    r = compileTypescriptBlock(e, b);
                    break;
                case pxtc.PAUSE_UNTIL_TYPE:
                    r = compilePauseUntilBlock(e, b, comments);
                    break;
                case pxtc.TS_DEBUGGER_TYPE:
                    r = compileDebuggeStatementBlock(e, b);
                    break;
                case pxtc.TS_BREAK_TYPE:
                    r = compileBreakStatementBlock(e, b);
                    break;
                case pxtc.TS_CONTINUE_TYPE:
                    r = compileContinueStatementBlock(e, b);
                    break;
                default:
                    let call = e.stdCallTable[b.type];
                    if (call)
                        r = [compileCall(e, b, comments)];
                    else
                        r = [blocks_1.mkStmt(compileExpression(e, b, comments))];
                    break;
            }
            let l = r[r.length - 1];
            if (l && !l.id)
                l.id = b.id;
            if (comments.length) {
                addCommentNodes(comments, r);
            }
            r.forEach(l => {
                if ((l.type === blocks_1.NT.Block || l.type === blocks_1.NT.Prefix && pxt.Util.startsWith(l.op, "//")) && (b.type != pxtc.ON_START_TYPE || !l.id)) {
                    l.id = b.id;
                }
            });
            return r;
        }
        function compileStatements(e, b) {
            let stmts = [];
            let firstBlock = b;
            while (b) {
                if (b.isEnabled())
                    append(stmts, compileStatementBlock(e, b));
                b = b.getNextBlock();
            }
            if (firstBlock && e.blockDeclarations[firstBlock.id]) {
                e.blockDeclarations[firstBlock.id].filter(v => !v.alreadyDeclared).forEach(varInfo => {
                    stmts.unshift(mkVariableDeclaration(varInfo, e.blocksInfo));
                    varInfo.alreadyDeclared = BlockDeclarationType.Implicit;
                });
            }
            return blocks_1.mkBlock(stmts);
        }
        function compileTypescriptBlock(e, b) {
            return b.getLines().map(line => blocks_1.mkText(line + "\n"));
        }
        function compileDebuggeStatementBlock(e, b) {
            if (b.getFieldValue("ON_OFF") == "1") {
                return [
                    blocks_1.mkText("debugger;\n")
                ];
            }
            return [];
        }
        function compileBreakStatementBlock(e, b) {
            return [blocks_1.mkText("break;\n")];
        }
        function compileContinueStatementBlock(e, b) {
            return [blocks_1.mkText("continue;\n")];
        }
        function prefixWithSemicolon(n) {
            const emptyStatement = blocks_1.mkStmt(blocks_1.mkText(";"));
            emptyStatement.glueToBlock = blocks_1.GlueMode.NoSpace;
            return blocks_1.mkGroup([emptyStatement, n]);
        }
        function compilePauseUntilBlock(e, b, comments) {
            const options = pxt.appTarget.runtime && pxt.appTarget.runtime.pauseUntilBlock;
            pxt.Util.assert(!!options, "target has block enabled");
            const ns = options.namespace;
            const name = options.callName || "pauseUntil";
            const arg = compileArgument(e, b, { definitionName: "PREDICATE", actualName: "PREDICATE" }, comments);
            const lambda = [blocks_1.mkGroup([blocks_1.mkText("() => "), arg])];
            if (ns) {
                return [blocks_1.mkStmt(blocks_1.H.namespaceCall(ns, name, lambda, false))];
            }
            else {
                return [blocks_1.mkStmt(blocks_1.H.mkCall(name, lambda, false, false))];
            }
        }
        // This function creates an empty environment where type inference has NOT yet
        // been performed.
        // - All variables have been assigned an initial [Point] in the union-find.
        // - Variables have been marked to indicate if they are compatible with the
        //   TouchDevelop for-loop model.
        function mkEnv(w, blockInfo, options = {}) {
            // The to-be-returned environment.
            let e = emptyEnv(w, options);
            e.blocksInfo = blockInfo;
            // append functions in stdcalltable
            if (blockInfo) {
                // Enums, tagged templates, and namespaces are not enclosed in namespaces,
                // so add them to the taken names to avoid collision
                Object.keys(blockInfo.apis.byQName).forEach(name => {
                    const info = blockInfo.apis.byQName[name];
                    // Note: the check for info.pkg filters out functions defined in the user's project.
                    // Otherwise, after the first compile the function will be renamed because it conflicts
                    // with itself. You can still get collisions if you attempt to define a function with
                    // the same name as a function defined in another file in the user's project (e.g. custom.ts)
                    if (info.pkg && (info.kind === 6 /* Enum */ || info.kind === 3 /* Function */ || info.kind === 5 /* Module */ || info.kind === 4 /* Variable */)) {
                        e.renames.takenNames[info.qName] = true;
                    }
                });
                if (blockInfo.enumsByName) {
                    Object.keys(blockInfo.enumsByName).forEach(k => e.enums.push(blockInfo.enumsByName[k]));
                }
                if (blockInfo.kindsByName) {
                    Object.keys(blockInfo.kindsByName).forEach(k => e.kinds.push(blockInfo.kindsByName[k]));
                }
                blockInfo.blocks
                    .forEach(fn => {
                    if (e.stdCallTable[fn.attributes.blockId]) {
                        pxt.reportError("blocks", "function already defined", {
                            "details": fn.attributes.blockId,
                            "qualifiedName": fn.qName,
                            "packageName": fn.pkg,
                        });
                        return;
                    }
                    e.renames.takenNames[fn.namespace] = true;
                    const comp = pxt.blocks.compileInfo(fn);
                    const instance = !!comp.thisParameter;
                    e.stdCallTable[fn.attributes.blockId] = {
                        namespace: fn.namespace,
                        f: fn.name,
                        comp,
                        attrs: fn.attributes,
                        isExtensionMethod: instance,
                        isExpression: fn.retType && fn.retType !== "void",
                        imageLiteral: fn.attributes.imageLiteral,
                        imageLiteralColumns: fn.attributes.imageLiteralColumns,
                        imageLiteralRows: fn.attributes.imageLiteralRows,
                        hasHandler: pxt.blocks.hasHandler(fn),
                        property: !fn.parameters,
                        isIdentity: fn.attributes.shim == "TD_ID"
                    };
                });
                w.getTopBlocks(false).filter(isFunctionDefinition).forEach(b => {
                    // Add functions to the rename map to prevent name collisions with variables
                    const name = b.type === "procedures_defnoreturn" ? b.getFieldValue("NAME") : b.getField("function_name").getText();
                    escapeVarName(name, e, true);
                });
            }
            return e;
        }
        blocks_1.mkEnv = mkEnv;
        function compileBlockAsync(b, blockInfo) {
            const w = b.workspace;
            const e = mkEnv(w, blockInfo);
            infer(w && w.getAllBlocks(false), e, w);
            const compiled = compileStatementBlock(e, b);
            removeAllPlaceholders();
            return tdASTtoTS(e, compiled);
        }
        blocks_1.compileBlockAsync = compileBlockAsync;
        function eventWeight(b, e) {
            if (b.type === ts.pxtc.ON_START_TYPE) {
                return 0;
            }
            const api = e.stdCallTable[b.type];
            const key = callKey(e, b);
            const hash = 1 + ts.pxtc.Util.codalHash16(key);
            if (api && api.attrs.afterOnStart)
                return hash;
            else
                return -hash;
        }
        function compileWorkspace(e, w, blockInfo) {
            try {
                // all compiled top level blocks are events
                let allBlocks = w.getAllBlocks(false);
                if (pxt.react.getTilemapProject) {
                    pxt.react.getTilemapProject().removeInactiveBlockAssets(allBlocks.map(b => b.id));
                }
                // the top blocks are storted by blockly
                let topblocks = w.getTopBlocks(true);
                // reorder remaining events by names (top blocks still contains disabled blocks)
                topblocks = topblocks.sort((a, b) => {
                    return eventWeight(a, e) - eventWeight(b, e);
                });
                // update disable blocks
                updateDisabledBlocks(e, allBlocks, topblocks);
                // drop disabled blocks
                allBlocks = allBlocks.filter(b => b.isEnabled());
                topblocks = topblocks.filter(b => b.isEnabled());
                trackAllVariables(topblocks, e);
                infer(allBlocks, e, w);
                const stmtsMain = [];
                // compile workspace comments, add them to the top
                const topComments = w.getTopComments(true);
                const commentMap = groupWorkspaceComments(topblocks, topComments);
                commentMap.orphans.forEach(comment => append(stmtsMain, compileWorkspaceComment(comment).children));
                topblocks.forEach(b => {
                    if (commentMap.idToComments[b.id]) {
                        commentMap.idToComments[b.id].forEach(comment => {
                            append(stmtsMain, compileWorkspaceComment(comment).children);
                        });
                    }
                    if (b.type == ts.pxtc.ON_START_TYPE)
                        append(stmtsMain, compileStatementBlock(e, b));
                    else {
                        const compiled = blocks_1.mkBlock(compileStatementBlock(e, b));
                        if (compiled.type == blocks_1.NT.Block)
                            append(stmtsMain, compiled.children);
                        else
                            stmtsMain.push(compiled);
                    }
                });
                const stmtsEnums = [];
                e.enums.forEach(info => {
                    const models = w.getVariablesOfType(info.name);
                    if (models && models.length) {
                        const members = models.map(m => {
                            const match = /^(\d+)([^0-9].*)$/.exec(m.name);
                            if (match) {
                                return [match[2], parseInt(match[1])];
                            }
                            else {
                                // Someone has been messing with the XML...
                                return [m.name, -1];
                            }
                        });
                        members.sort((a, b) => a[1] - b[1]);
                        const nodes = [];
                        let lastValue = -1;
                        members.forEach(([name, value], index) => {
                            let newNode;
                            if (info.isBitMask) {
                                const shift = Math.log2(value);
                                if (shift >= 0 && Math.floor(shift) === shift) {
                                    newNode = blocks_1.H.mkAssign(blocks_1.mkText(name), blocks_1.H.mkSimpleCall("<<", [blocks_1.H.mkNumberLiteral(1), blocks_1.H.mkNumberLiteral(shift)]));
                                }
                            }
                            else if (info.isHash) {
                                const hash = ts.pxtc.Util.codalHash16(name.toLowerCase());
                                newNode = blocks_1.H.mkAssign(blocks_1.mkText(name), blocks_1.H.mkNumberLiteral(hash));
                            }
                            if (!newNode) {
                                if (value === lastValue + 1) {
                                    newNode = blocks_1.mkText(name);
                                }
                                else {
                                    newNode = blocks_1.H.mkAssign(blocks_1.mkText(name), blocks_1.H.mkNumberLiteral(value));
                                }
                            }
                            nodes.push(newNode);
                            lastValue = value;
                        });
                        const declarations = blocks_1.mkCommaSep(nodes, true);
                        declarations.glueToBlock = blocks_1.GlueMode.NoSpace;
                        stmtsEnums.push(blocks_1.mkGroup([
                            blocks_1.mkText(`enum ${info.name}`),
                            blocks_1.mkBlock([declarations])
                        ]));
                    }
                });
                e.kinds.forEach(info => {
                    const models = w.getVariablesOfType("KIND_" + info.name);
                    if (models && models.length) {
                        const userDefined = models.map(m => m.name).filter(n => info.initialMembers.indexOf(n) === -1);
                        if (userDefined.length) {
                            stmtsEnums.push(blocks_1.mkGroup([
                                blocks_1.mkText(`namespace ${info.name}`),
                                blocks_1.mkBlock(userDefined.map(varName => blocks_1.mkStmt(blocks_1.mkText(`export const ${varName} = ${info.name}.${info.createFunctionName}()`))))
                            ]));
                        }
                    }
                });
                const leftoverVars = e.allVariables.filter(v => !v.alreadyDeclared).map(v => mkVariableDeclaration(v, blockInfo));
                e.allVariables.filter(v => v.alreadyDeclared === BlockDeclarationType.Implicit && !v.isAssigned).forEach(v => {
                    const t = getConcreteType(v.type);
                    // The primitive types all get initializers set to default values, other types are set to null
                    if (t.type === "string" || t.type === "number" || t.type === "boolean" || isArrayType(t.type))
                        return;
                    e.diagnostics.push({
                        blockId: v.firstReference && v.firstReference.id,
                        message: lf("Variable '{0}' is never assigned", v.name)
                    });
                });
                return [stmtsEnums.concat(leftoverVars.concat(stmtsMain)), e.diagnostics];
            }
            catch (err) {
                let be = err.block;
                if (be) {
                    be.setWarningText(err + "");
                    e.errors.push(be);
                }
                else {
                    throw err;
                }
            }
            finally {
                removeAllPlaceholders();
            }
            return [null, null]; // unreachable
        }
        function callKey(e, b) {
            if (b.type == ts.pxtc.ON_START_TYPE)
                return JSON.stringify({ name: ts.pxtc.ON_START_TYPE });
            else if (b.type == ts.pxtc.FUNCTION_DEFINITION_TYPE)
                return JSON.stringify({ type: "function", name: b.getFieldValue("function_name") });
            const key = JSON.stringify(blockKey(b))
                .replace(/"id"\s*:\s*"[^"]+"/g, ''); // remove blockly ids
            return key;
        }
        blocks_1.callKey = callKey;
        function blockKey(b) {
            const fields = [];
            const inputs = [];
            for (const input of b.inputList) {
                for (const field of input.fieldRow) {
                    if (field.name) {
                        fields.push(field.getText());
                    }
                }
                if (input.type === Blockly.INPUT_VALUE) {
                    if (input.connection.targetBlock()) {
                        inputs.push(blockKey(input.connection.targetBlock()));
                    }
                    else {
                        inputs.push(null);
                    }
                }
            }
            return {
                type: b.type,
                fields,
                inputs
            };
        }
        function setChildrenEnabled(block, enabled) {
            block.setEnabled(enabled);
            // propagate changes
            const children = block.getDescendants(false);
            for (const child of children) {
                child.setEnabled(enabled);
            }
        }
        function updateDisabledBlocks(e, allBlocks, topBlocks) {
            // unset disabled
            allBlocks.forEach(b => b.setEnabled(true));
            // update top blocks
            const events = {};
            function flagDuplicate(key, block) {
                const otherEvent = events[key];
                if (otherEvent) {
                    // another block is already registered
                    setChildrenEnabled(block, false);
                }
                else {
                    setChildrenEnabled(block, true);
                    events[key] = block;
                }
            }
            topBlocks.forEach(b => {
                const call = e.stdCallTable[b.type];
                // multiple calls allowed
                if (b.type == ts.pxtc.ON_START_TYPE)
                    flagDuplicate(ts.pxtc.ON_START_TYPE, b);
                else if (isFunctionDefinition(b) || call && call.attrs.blockAllowMultiple && !call.attrs.handlerStatement)
                    return;
                // is this an event?
                else if (call && call.hasHandler && !call.attrs.handlerStatement) {
                    // compute key that identifies event call
                    // detect if same event is registered already
                    const key = call.attrs.blockHandlerKey || callKey(e, b);
                    flagDuplicate(key, b);
                }
                else {
                    // all non-events are disabled
                    let t = b;
                    while (t) {
                        setChildrenEnabled(b, false);
                        t = t.getNextBlock();
                    }
                }
            });
        }
        function findBlockIdByPosition(sourceMap, loc) {
            if (!loc)
                return undefined;
            let bestChunk;
            let bestChunkLength;
            // look for smallest chunk containing the block
            for (let i = 0; i < sourceMap.length; ++i) {
                let chunk = sourceMap[i];
                if (chunk.startPos <= loc.start
                    && chunk.endPos >= loc.start + loc.length
                    && (!bestChunk || bestChunkLength > chunk.endPos - chunk.startPos)) {
                    bestChunk = chunk;
                    bestChunkLength = chunk.endPos - chunk.startPos;
                }
            }
            if (bestChunk) {
                return bestChunk.id;
            }
            return undefined;
        }
        blocks_1.findBlockIdByPosition = findBlockIdByPosition;
        function findBlockIdByLine(sourceMap, loc) {
            if (!loc)
                return undefined;
            let bestChunk;
            let bestChunkLength;
            // look for smallest chunk containing the block
            for (let i = 0; i < sourceMap.length; ++i) {
                let chunk = sourceMap[i];
                if (chunk.startLine <= loc.start
                    && chunk.endLine > loc.start + loc.length
                    && (!bestChunk || bestChunkLength > chunk.endLine - chunk.startLine)) {
                    bestChunk = chunk;
                    bestChunkLength = chunk.endLine - chunk.startLine;
                }
            }
            if (bestChunk) {
                return bestChunk.id;
            }
            return undefined;
        }
        blocks_1.findBlockIdByLine = findBlockIdByLine;
        function compileAsync(b, blockInfo, opts = {}) {
            const e = mkEnv(b, blockInfo, opts);
            const [nodes, diags] = compileWorkspace(e, b, blockInfo);
            const result = tdASTtoTS(e, nodes, diags);
            return result;
        }
        blocks_1.compileAsync = compileAsync;
        function tdASTtoTS(env, app, diags) {
            let res = blocks_1.flattenNode(app);
            // Note: the result of format is not used!
            return workerOpAsync("format", { format: { input: res.output, pos: 1 } }).then(() => {
                return {
                    source: res.output,
                    sourceMap: res.sourceMap,
                    stats: env.stats,
                    diagnostics: diags || []
                };
            });
        }
        function maybeAddComment(b, comments) {
            var _a;
            // Check if getCommentText exists, block may be placeholder
            const text = (_a = b.getCommentText) === null || _a === void 0 ? void 0 : _a.call(b);
            if (text) {
                comments.push(text);
            }
        }
        function addCommentNodes(comments, r) {
            const commentNodes = [];
            for (const comment of comments) {
                for (const line of comment.split("\n")) {
                    commentNodes.push(blocks_1.mkText(`// ${line}`));
                    commentNodes.push(blocks_1.mkNewLine());
                }
            }
            for (const commentNode of commentNodes.reverse()) {
                r.unshift(commentNode);
            }
        }
        function mkVariableDeclaration(v, blockInfo) {
            const t = getConcreteType(v.type);
            let defl;
            if (t.type === "Array") {
                defl = blocks_1.mkText("[]");
            }
            else {
                defl = defaultValueForType(t);
            }
            let tp = "";
            if (defl.op == "null" || defl.op == "[]") {
                let tpname = t.type;
                // If the type is "Array" or null[] it means that we failed to narrow the type of array.
                // Best we can do is just default to number[]
                if (tpname === "Array" || tpname === "null[]") {
                    tpname = "number[]";
                }
                let tpinfo = blockInfo.apis.byQName[tpname];
                if (tpinfo && tpinfo.attributes.autoCreate)
                    defl = blocks_1.mkText(tpinfo.attributes.autoCreate + "()");
                else
                    tp = ": " + tpname;
            }
            return blocks_1.mkStmt(blocks_1.mkText("let " + v.escapedName + tp + " = "), defl);
        }
        function countOptionals(b, func) {
            if (func.attrs.compileHiddenArguments) {
                return func.comp.parameters.reduce((prev, block) => {
                    if (block.isOptional)
                        prev++;
                    return prev;
                }, 0);
            }
            if (b.mutationToDom) {
                const el = b.mutationToDom();
                if (el.hasAttribute("_expanded")) {
                    const val = parseInt(el.getAttribute("_expanded"));
                    return isNaN(val) ? 0 : Math.max(val, 0);
                }
            }
            return 0;
        }
        function visibleParams({ comp }, optionalCount) {
            const res = [];
            if (comp.thisParameter) {
                res.push(comp.thisParameter);
            }
            comp.parameters.forEach(p => {
                if (p.isOptional && optionalCount > 0) {
                    res.push(p);
                    --optionalCount;
                }
                else if (!p.isOptional) {
                    res.push(p);
                }
            });
            return res;
        }
        function getEscapedCBParameters(b, stdfun, e) {
            return getCBParameters(b, stdfun).map(binding => lookup(e, b, binding.name).escapedName);
        }
        function getCBParameters(b, stdfun) {
            let handlerArgs = [];
            if (stdfun.attrs.draggableParameters) {
                for (let i = 0; i < stdfun.comp.handlerArgs.length; i++) {
                    const arg = stdfun.comp.handlerArgs[i];
                    let varName;
                    const varBlock = getInputTargetBlock(b, "HANDLER_DRAG_PARAM_" + arg.name);
                    if (stdfun.attrs.draggableParameters === "reporter") {
                        varName = varBlock && varBlock.getFieldValue("VALUE");
                    }
                    else {
                        varName = varBlock && varBlock.getField("VAR").getText();
                    }
                    if (varName !== null) {
                        handlerArgs.push({
                            name: varName,
                            type: mkPoint(arg.type)
                        });
                    }
                    else {
                        break;
                    }
                }
            }
            else {
                for (let i = 0; i < stdfun.comp.handlerArgs.length; i++) {
                    const arg = stdfun.comp.handlerArgs[i];
                    const varField = b.getField("HANDLER_" + arg.name);
                    const varName = varField && varField.getText();
                    if (varName !== null) {
                        handlerArgs.push({
                            name: varName,
                            type: mkPoint(arg.type)
                        });
                    }
                    else {
                        break;
                    }
                }
            }
            return handlerArgs;
        }
        function groupWorkspaceComments(blocks, comments) {
            if (!blocks.length || blocks.some(b => !b.rendered)) {
                return {
                    orphans: comments,
                    idToComments: {}
                };
            }
            const blockBounds = blocks.map(block => {
                const bounds = block.getBoundingRectangle();
                const size = block.getHeightWidth();
                return {
                    id: block.id,
                    x: bounds.left,
                    y: bounds.top,
                    width: size.width,
                    height: size.height
                };
            });
            const map = {
                orphans: [],
                idToComments: {}
            };
            const radius = 20;
            for (const comment of comments) {
                const bounds = comment.getBoundingRectangle();
                const size = comment.getHeightWidth();
                const x = bounds.left;
                const y = bounds.top;
                let parent;
                for (const rect of blockBounds) {
                    if (doesIntersect(x, y, size.width, size.height, rect)) {
                        parent = rect;
                    }
                    else if (!parent && doesIntersect(x - radius, y - radius, size.width + radius * 2, size.height + radius * 2, rect)) {
                        parent = rect;
                    }
                }
                if (parent) {
                    if (!map.idToComments[parent.id]) {
                        map.idToComments[parent.id] = [];
                    }
                    map.idToComments[parent.id].push(comment);
                }
                else {
                    map.orphans.push(comment);
                }
            }
            return map;
        }
        function referencedWithinScope(scope, varID) {
            if (scope.referencedVars.indexOf(varID) !== -1) {
                return true;
            }
            else {
                for (const child of scope.children) {
                    if (referencedWithinScope(child, varID))
                        return true;
                }
            }
            return false;
        }
        function assignedWithinScope(scope, varID) {
            if (scope.assignedVars.indexOf(varID) !== -1) {
                return true;
            }
            else {
                for (const child of scope.children) {
                    if (assignedWithinScope(child, varID))
                        return true;
                }
            }
            return false;
        }
        function escapeVariables(current, e) {
            for (const varName of Object.keys(current.declaredVars)) {
                const info = current.declaredVars[varName];
                if (!info.escapedName)
                    info.escapedName = escapeVarName(varName);
            }
            current.children.forEach(c => escapeVariables(c, e));
            function escapeVarName(originalName) {
                if (!originalName)
                    return '_';
                let n = ts.pxtc.escapeIdentifier(originalName);
                if (e.renames.takenNames[n] || nameIsTaken(n, current, originalName)) {
                    let i = 2;
                    while (e.renames.takenNames[n + i] || nameIsTaken(n + i, current, originalName)) {
                        i++;
                    }
                    n += i;
                }
                return n;
            }
            function nameIsTaken(name, scope, originalName) {
                if (scope) {
                    for (const varName of Object.keys(scope.declaredVars)) {
                        const info = scope.declaredVars[varName];
                        if ((originalName !== info.name || info.name !== info.escapedName) && info.escapedName === name)
                            return true;
                    }
                    return nameIsTaken(name, scope.parent, originalName);
                }
                return false;
            }
        }
        function findCommonScope(current, varID) {
            let ref;
            if (current.referencedVars.indexOf(varID) !== -1) {
                return current;
            }
            for (const child of current.children) {
                if (referencedWithinScope(child, varID)) {
                    if (assignedWithinScope(child, varID)) {
                        return current;
                    }
                    if (!ref) {
                        ref = child;
                    }
                    else {
                        return current;
                    }
                }
            }
            return ref ? findCommonScope(ref, varID) : undefined;
        }
        function trackAllVariables(topBlocks, e) {
            let id = 1;
            let topScope;
            // First, look for on-start
            topBlocks.forEach(block => {
                if (block.type === ts.pxtc.ON_START_TYPE) {
                    const firstStatement = block.getInputTargetBlock("HANDLER");
                    if (firstStatement) {
                        topScope = {
                            firstStatement: firstStatement,
                            declaredVars: {},
                            referencedVars: [],
                            children: [],
                            assignedVars: []
                        };
                        trackVariables(firstStatement, topScope, e);
                    }
                }
            });
            // If we didn't find on-start, then create an empty top scope
            if (!topScope) {
                topScope = {
                    firstStatement: null,
                    declaredVars: {},
                    referencedVars: [],
                    children: [],
                    assignedVars: []
                };
            }
            topBlocks.forEach(block => {
                if (block.type === ts.pxtc.ON_START_TYPE) {
                    return;
                }
                trackVariables(block, topScope, e);
            });
            Object.keys(topScope.declaredVars).forEach(varName => {
                const varID = topScope.declaredVars[varName];
                delete topScope.declaredVars[varName];
                const declaringScope = findCommonScope(topScope, varID.id) || topScope;
                declaringScope.declaredVars[varName] = varID;
            });
            markDeclarationLocations(topScope, e);
            escapeVariables(topScope, e);
            return topScope;
            function trackVariables(block, currentScope, e) {
                e.idToScope[block.id] = currentScope;
                if (block.type === "variables_get") {
                    const name = block.getField("VAR").getText();
                    const info = findOrDeclareVariable(name, currentScope);
                    currentScope.referencedVars.push(info.id);
                }
                else if (block.type === "variables_set" || block.type === "variables_change") {
                    const name = block.getField("VAR").getText();
                    const info = findOrDeclareVariable(name, currentScope);
                    currentScope.assignedVars.push(info.id);
                    currentScope.referencedVars.push(info.id);
                }
                else if (block.type === pxtc.TS_STATEMENT_TYPE) {
                    const declaredVars = block.declaredVariables;
                    if (declaredVars) {
                        const varNames = declaredVars.split(",");
                        varNames.forEach(vName => {
                            const info = findOrDeclareVariable(vName, currentScope);
                            info.alreadyDeclared = BlockDeclarationType.Argument;
                        });
                    }
                }
                if (hasStatementInput(block)) {
                    const vars = getDeclaredVariables(block, e).map(binding => {
                        return Object.assign(Object.assign({}, binding), { id: id++ });
                    });
                    let parentScope = currentScope;
                    if (vars.length) {
                        // We need to create a scope for this block, and then a scope
                        // for each statement input (in case there are multiple)
                        parentScope = {
                            parent: currentScope,
                            firstStatement: block,
                            declaredVars: {},
                            referencedVars: [],
                            assignedVars: [],
                            children: []
                        };
                        vars.forEach(v => {
                            v.alreadyDeclared = BlockDeclarationType.Assigned;
                            parentScope.declaredVars[v.name] = v;
                        });
                        e.idToScope[block.id] = parentScope;
                    }
                    if (currentScope !== parentScope) {
                        currentScope.children.push(parentScope);
                    }
                    forEachChildExpression(block, child => {
                        trackVariables(child, parentScope, e);
                    });
                    forEachStatementInput(block, connectedBlock => {
                        const newScope = {
                            parent: parentScope,
                            firstStatement: connectedBlock,
                            declaredVars: {},
                            referencedVars: [],
                            assignedVars: [],
                            children: []
                        };
                        parentScope.children.push(newScope);
                        trackVariables(connectedBlock, newScope, e);
                    });
                }
                else {
                    forEachChildExpression(block, child => {
                        trackVariables(child, currentScope, e);
                    });
                }
                if (block.nextConnection && block.nextConnection.targetBlock()) {
                    trackVariables(block.nextConnection.targetBlock(), currentScope, e);
                }
            }
            function findOrDeclareVariable(name, scope) {
                if (scope.declaredVars[name]) {
                    return scope.declaredVars[name];
                }
                else if (scope.parent) {
                    return findOrDeclareVariable(name, scope.parent);
                }
                else {
                    // Declare it in the top scope
                    scope.declaredVars[name] = {
                        name,
                        type: mkPoint(null),
                        id: id++
                    };
                    return scope.declaredVars[name];
                }
            }
        }
        function getVarInfo(name, scope) {
            if (scope && scope.declaredVars[name]) {
                return scope.declaredVars[name];
            }
            else if (scope && scope.parent) {
                return getVarInfo(name, scope.parent);
            }
            else {
                return null;
            }
        }
        function hasStatementInput(block) {
            return block.inputList.some(i => i.type === Blockly.NEXT_STATEMENT);
        }
        function getDeclaredVariables(block, e) {
            switch (block.type) {
                case 'pxt_controls_for':
                case 'controls_simple_for':
                    return [{
                            name: getLoopVariableField(block).getField("VAR").getText(),
                            type: pNumber
                        }];
                case 'pxt_controls_for_of':
                case 'controls_for_of':
                    return [{
                            name: getLoopVariableField(block).getField("VAR").getText(),
                            type: mkPoint(null)
                        }];
                case 'function_definition':
                    return block.getArguments().filter(arg => arg.type === "Array")
                        .map(arg => {
                        const point = mkPoint(null);
                        point.isArrayType = true;
                        return {
                            name: arg.name,
                            type: point,
                            isFunctionParameter: true
                        };
                    });
                default:
                    break;
            }
            if (isMutatingBlock(block)) {
                const declarations = block.mutation.getDeclaredVariables();
                if (declarations) {
                    return Object.keys(declarations).map(varName => ({
                        name: varName,
                        type: mkPoint(declarations[varName])
                    }));
                }
            }
            let stdFunc = e.stdCallTable[block.type];
            if (stdFunc && stdFunc.comp.handlerArgs.length) {
                return getCBParameters(block, stdFunc);
            }
            return [];
        }
        function forEachChildExpression(block, cb, recursive = false) {
            block.inputList.filter(i => i.type === Blockly.INPUT_VALUE).forEach(i => {
                if (i.connection && i.connection.targetBlock()) {
                    cb(i.connection.targetBlock());
                    if (recursive) {
                        forEachChildExpression(i.connection.targetBlock(), cb, recursive);
                    }
                }
            });
        }
        function forEachStatementInput(block, cb) {
            block.inputList.filter(i => i.type === Blockly.NEXT_STATEMENT).forEach(i => {
                if (i.connection && i.connection.targetBlock()) {
                    cb(i.connection.targetBlock());
                }
            });
        }
        function printScope(scope, depth = 0) {
            const declared = Object.keys(scope.declaredVars).map(k => `${k}(${scope.declaredVars[k].id})`).join(",");
            const referenced = scope.referencedVars.join(", ");
            console.log(`${mkIndent(depth)}SCOPE: ${scope.firstStatement ? scope.firstStatement.type : "TOP-LEVEL"}`);
            if (declared.length) {
                console.log(`${mkIndent(depth)}DECS: ${declared}`);
            }
            // console.log(`${mkIndent(depth)}REFS: ${referenced}`)
            scope.children.forEach(s => printScope(s, depth + 1));
        }
        function mkIndent(depth) {
            let res = "";
            for (let i = 0; i < depth; i++) {
                res += "    ";
            }
            return res;
        }
        function markDeclarationLocations(scope, e) {
            const declared = Object.keys(scope.declaredVars);
            if (declared.length) {
                const decls = declared.map(name => scope.declaredVars[name]);
                if (scope.firstStatement) {
                    // If we can't find a better place to declare the variable, we'll declare
                    // it before the first statement in the code block so we need to keep
                    // track of the blocks ids
                    e.blockDeclarations[scope.firstStatement.id] = decls.concat(e.blockDeclarations[scope.firstStatement.id] || []);
                }
                decls.forEach(d => e.allVariables.push(d));
            }
            scope.children.forEach(child => markDeclarationLocations(child, e));
        }
        function doesIntersect(x, y, width, height, other) {
            const xOverlap = between(x, other.x, other.x + other.width) || between(other.x, x, x + width);
            const yOverlap = between(y, other.y, other.y + other.height) || between(other.y, y, y + height);
            return xOverlap && yOverlap;
            function between(val, lower, upper) {
                return val >= lower && val <= upper;
            }
        }
        function isFunctionDefinition(b) {
            return b.type === "procedures_defnoreturn" || b.type === "function_definition";
        }
        function getFunctionName(functionBlock) {
            return functionBlock.getField("function_name").getText();
        }
        // @param strict - if true, only return true if there is a return statement
        // somewhere in the call graph that returns a call to this function. If false,
        // return true if the function is called as an expression anywhere in the call
        // graph
        function isFunctionRecursive(b, strict) {
            const functionName = getFunctionName(b);
            const visited = {};
            return checkForCallRecursive(b);
            function checkForCallRecursive(functionDefinition) {
                let calls;
                if (strict) {
                    calls = functionDefinition.getDescendants(false)
                        .filter(child => child.type == "function_return")
                        .map(returnStatement => getInputTargetBlock(returnStatement, "RETURN_VALUE"))
                        .filter(returnValue => returnValue && returnValue.type === "function_call_output");
                }
                else {
                    calls = functionDefinition.getDescendants(false).filter(child => child.type == "function_call_output");
                }
                for (const call of calls) {
                    const callName = getFunctionName(call);
                    if (callName === functionName)
                        return true;
                    if (visited[callName])
                        continue;
                    visited[callName] = true;
                    if (checkForCallRecursive(Blockly.Functions.getDefinition(callName, call.workspace))) {
                        return true;
                    }
                }
                return false;
            }
        }
        function isPlaceholderBlock(b) {
            return b.type == "placeholder" || b.type === pxtc.TS_OUTPUT_TYPE;
        }
    })(blocks = pxt.blocks || (pxt.blocks = {}));
})(pxt || (pxt = {}));
var pxt;
(function (pxt) {
    var blocks;
    (function (blocks) {
        let registeredFieldEditors = {};
        function initFieldEditors() {
            registerFieldEditor('text', pxtblockly.FieldTextInput);
            registerFieldEditor('note', pxtblockly.FieldNote);
            registerFieldEditor('gridpicker', pxtblockly.FieldGridPicker);
            registerFieldEditor('textdropdown', pxtblockly.FieldTextDropdown);
            registerFieldEditor('numberdropdown', pxtblockly.FieldNumberDropdown);
            registerFieldEditor('imagedropdown', pxtblockly.FieldImageDropdown);
            registerFieldEditor('colorwheel', pxtblockly.FieldColorWheel);
            registerFieldEditor('toggle', pxtblockly.FieldToggle);
            registerFieldEditor('toggleonoff', pxtblockly.FieldToggleOnOff);
            registerFieldEditor('toggleyesno', pxtblockly.FieldToggleYesNo);
            registerFieldEditor('toggleupdown', pxtblockly.FieldToggleUpDown);
            registerFieldEditor('toggledownup', pxtblockly.FieldToggleDownUp);
            registerFieldEditor('togglehighlow', pxtblockly.FieldToggleHighLow);
            registerFieldEditor('togglewinlose', pxtblockly.FieldToggleWinLose);
            registerFieldEditor('colornumber', pxtblockly.FieldColorNumber);
            registerFieldEditor('images', pxtblockly.FieldImages);
            registerFieldEditor('sprite', pxtblockly.FieldSpriteEditor);
            registerFieldEditor('animation', pxtblockly.FieldAnimationEditor);
            registerFieldEditor('tilemap', pxtblockly.FieldTilemap);
            registerFieldEditor('tileset', pxtblockly.FieldTileset);
            registerFieldEditor('speed', pxtblockly.FieldSpeed);
            registerFieldEditor('turnratio', pxtblockly.FieldTurnRatio);
            registerFieldEditor('protractor', pxtblockly.FieldProtractor);
            registerFieldEditor('position', pxtblockly.FieldPosition);
            registerFieldEditor('melody', pxtblockly.FieldCustomMelody);
            registerFieldEditor('soundeffect', pxtblockly.FieldSoundEffect);
            registerFieldEditor('autocomplete', pxtblockly.FieldAutoComplete);
        }
        blocks.initFieldEditors = initFieldEditors;
        function registerFieldEditor(selector, field, validator) {
            if (registeredFieldEditors[selector] == undefined) {
                registeredFieldEditors[selector] = {
                    field: field,
                    validator: validator
                };
            }
        }
        blocks.registerFieldEditor = registerFieldEditor;
        function createFieldEditor(selector, text, params) {
            if (registeredFieldEditors[selector] == undefined) {
                console.error(`Field editor ${selector} not registered`);
                return null;
            }
            if (!params) {
                params = {};
            }
            pxt.Util.assert(params.lightMode == undefined, "lightMode is a reserved parameter for custom fields");
            params.lightMode = pxt.options.light;
            let customField = registeredFieldEditors[selector];
            let instance = new customField.field(text, params, customField.validator);
            return instance;
        }
        blocks.createFieldEditor = createFieldEditor;
    })(blocks = pxt.blocks || (pxt.blocks = {}));
})(pxt || (pxt = {}));
var pxt;
(function (pxt) {
    var blocks;
    (function (blocks) {
        // sniff ids to see if the xml was completly reconstructed
        function needsDecompiledDiff(oldXml, newXml) {
            if (!oldXml || !newXml)
                return false;
            // collect all ids
            const oldids = {};
            oldXml.replace(/id="([^"]+)"/g, (m, id) => { oldids[id] = true; return ""; });
            if (!Object.keys(oldids).length)
                return false;
            // test if any newid exists in old
            let total = 0;
            let found = 0;
            newXml.replace(/id="([^"]+)"/g, (m, id) => {
                total++;
                if (oldids[id])
                    found++;
                return "";
            });
            return total > 0 && found == 0;
        }
        blocks.needsDecompiledDiff = needsDecompiledDiff;
        function diffXml(oldXml, newXml, options) {
            const oldWs = pxt.blocks.loadWorkspaceXml(oldXml, true);
            const newWs = pxt.blocks.loadWorkspaceXml(newXml, true);
            return diffWorkspace(oldWs, newWs, options);
        }
        blocks.diffXml = diffXml;
        const UNMODIFIED_COLOR = "#d0d0d0";
        // Workspaces are modified in place!
        function diffWorkspace(oldWs, newWs, options) {
            try {
                Blockly.Events.disable();
                return diffWorkspaceNoEvents(oldWs, newWs, options);
            }
            catch (e) {
                pxt.reportException(e);
                return {
                    ws: undefined,
                    message: lf("Oops, we could not diff those blocks."),
                    error: e,
                    deleted: 0,
                    added: 0,
                    modified: 0
                };
            }
            finally {
                Blockly.Events.enable();
            }
        }
        function logger() {
            const log = pxt.options.debug || (window && /diffdbg=1/.test(window.location.href))
                ? console.log : (message, ...args) => { };
            return log;
        }
        function diffWorkspaceNoEvents(oldWs, newWs, options) {
            pxt.tickEvent("blocks.diff", { started: 1 });
            options = options || {};
            const log = logger();
            if (!oldWs) {
                return {
                    ws: undefined,
                    message: lf("All blocks are new."),
                    added: 0,
                    deleted: 0,
                    modified: 1
                }; // corrupted blocks
            }
            if (!newWs) {
                return {
                    ws: undefined,
                    message: lf("The current blocks seem corrupted."),
                    added: 0,
                    deleted: 0,
                    modified: 1
                }; // corrupted blocks
            }
            // remove all unmodified topblocks
            // when doing a Blocks->TS roundtrip, all ids are trashed.
            const oldXml = pxt.Util.toDictionary(oldWs.getTopBlocks(false), b => normalizedDom(b, true));
            newWs.getTopBlocks(false)
                .forEach(newb => {
                const newn = normalizedDom(newb, true);
                // try to find by id or by matching normalized xml
                const oldb = oldWs.getBlockById(newb.id) || oldXml[newn];
                if (oldb) {
                    const oldn = normalizedDom(oldb, true);
                    if (newn == oldn) {
                        log(`fast unmodified top `, newb.id);
                        newb.dispose(false);
                        oldb.dispose(false);
                    }
                }
            });
            // we'll ignore disabled blocks in the final output
            const oldBlocks = oldWs.getAllBlocks(false).filter(b => b.isEnabled());
            const oldTopBlocks = oldWs.getTopBlocks(false).filter(b => b.isEnabled());
            const newBlocks = newWs.getAllBlocks(false).filter(b => b.isEnabled());
            log(`blocks`, newBlocks.map(b => b.toDevString()));
            log(newBlocks);
            if (oldBlocks.length == 0 && newBlocks.length == 0) {
                pxt.tickEvent("blocks.diff", { moves: 1 });
                return {
                    ws: undefined,
                    message: lf("Some blocks were moved or changed."),
                    added: 0,
                    deleted: 0,
                    modified: 1
                }; // just moves
            }
            // locate deleted and added blocks
            const deletedTopBlocks = oldTopBlocks.filter(b => !newWs.getBlockById(b.id));
            const deletedBlocks = oldBlocks.filter(b => !newWs.getBlockById(b.id));
            const addedBlocks = newBlocks.filter(b => !oldWs.getBlockById(b.id));
            // clone new workspace into rendering workspace
            const ws = pxt.blocks.initRenderingWorkspace();
            const newXml = pxt.blocks.saveWorkspaceXml(newWs, true);
            pxt.blocks.domToWorkspaceNoEvents(Blockly.Xml.textToDom(newXml), ws);
            // delete disabled blocks from final workspace
            ws.getAllBlocks(false).filter(b => !b.isEnabled()).forEach(b => {
                log('disabled ', b.toDevString());
                b.dispose(false);
            });
            const todoBlocks = pxt.Util.toDictionary(ws.getAllBlocks(false), b => b.id);
            log(`todo blocks`, todoBlocks);
            logTodo('start');
            // 1. deleted top blocks
            if (!options.hideDeletedTopBlocks) {
                deletedTopBlocks.forEach(b => {
                    log(`deleted top ${b.toDevString()}`);
                    done(b);
                    const b2 = cloneIntoDiff(b);
                    done(b2);
                    b2.setEnabled(false);
                });
                logTodo('deleted top');
            }
            // 2. added blocks
            addedBlocks.map(b => ws.getBlockById(b.id))
                .filter(b => !!b) // ignore disabled
                .forEach(b => {
                log(`added ${b.toDevString()}`);
                //b.inputList[0].insertFieldAt(0, new Blockly.FieldImage(ADD_IMAGE_DATAURI, 24, 24, false));
                done(b);
            });
            logTodo('added');
            // 3. delete statement blocks
            // inject deleted blocks in new workspace
            const dids = {};
            if (!options.hideDeletedBlocks) {
                const deletedStatementBlocks = deletedBlocks
                    .filter(b => !todoBlocks[b.id]
                    && !isUsed(b)
                    && (!b.outputConnection || !b.outputConnection.isConnected()) // ignore reporters
                );
                deletedStatementBlocks
                    .forEach(b => {
                    const b2 = cloneIntoDiff(b);
                    dids[b.id] = b2.id;
                    log(`deleted block ${b.toDevString()}->${b2.toDevString()}`);
                });
                // connect deleted blocks together
                deletedStatementBlocks
                    .forEach(b => stitch(b));
            }
            // 4. moved blocks
            let modified = 0;
            pxt.Util.values(todoBlocks).filter(b => moved(b)).forEach(b => {
                log(`moved ${b.toDevString()}`);
                delete todoBlocks[b.id];
                markUsed(b);
                modified++;
            });
            logTodo('moved');
            // 5. blocks with field properties that changed
            pxt.Util.values(todoBlocks).filter(b => changed(b)).forEach(b => {
                log(`changed ${b.toDevString()}`);
                delete todoBlocks[b.id];
                markUsed(b);
                modified++;
            });
            logTodo('changed');
            // delete unmodified top blocks
            ws.getTopBlocks(false)
                .forEach(b => {
                if (!findUsed(b)) {
                    log(`unmodified top ${b.toDevString()}`);
                    delete todoBlocks[b.id];
                    b.dispose(false);
                }
            });
            logTodo('cleaned');
            // all unmodifed blocks are greyed out
            pxt.Util.values(todoBlocks).filter(b => !!ws.getBlockById(b.id)).forEach(b => {
                unmodified(b);
            });
            logTodo('unmodified');
            // if nothing is left in the workspace, we "missed" change
            if (!ws.getAllBlocks(false).length) {
                pxt.tickEvent("blocks.diff", { missed: 1 });
                return {
                    ws,
                    message: lf("Some blocks were changed."),
                    deleted: deletedBlocks.length,
                    added: addedBlocks.length,
                    modified: modified
                };
            }
            // make sure everything is rendered
            ws.resize();
            Blockly.svgResize(ws);
            // final render
            const svg = pxt.blocks.renderWorkspace(options.renderOptions || {
                emPixels: 20,
                layout: blocks.BlockLayout.Flow,
                aspectRatio: 0.5,
                useViewWidth: true
            });
            // and we're done
            const r = {
                ws,
                svg: svg,
                deleted: deletedBlocks.length,
                added: addedBlocks.length,
                modified: modified
            };
            pxt.tickEvent("blocks.diff", { deleted: r.deleted, added: r.added, modified: r.modified });
            return r;
            function stitch(b) {
                log(`stitching ${b.toDevString()}->${dids[b.id]}`);
                const wb = ws.getBlockById(dids[b.id]);
                wb.setEnabled(false);
                markUsed(wb);
                done(wb);
                // connect previous connection to delted or existing block
                const previous = b.getPreviousBlock();
                if (previous) {
                    const previousw = ws.getBlockById(dids[previous.id]) || ws.getBlockById(previous.id);
                    log(`previous ${b.id}->${wb.toDevString()}: ${previousw.toDevString()}`);
                    if (previousw) {
                        // either connected under or in the block
                        if (previousw.nextConnection)
                            wb.previousConnection.connect(previousw.nextConnection);
                        else {
                            const ic = previousw.inputList.slice()
                                .reverse()
                                .find(input => input.connection && input.connection.type == Blockly.NEXT_STATEMENT);
                            if (ic)
                                wb.previousConnection.connect(ic.connection);
                        }
                    }
                }
                // connect next connection to delete or existing block
                const next = b.getNextBlock();
                if (next) {
                    const nextw = ws.getBlockById(dids[next.id]) || ws.getBlockById(next.id);
                    if (nextw) {
                        log(`next ${b.id}->${wb.toDevString()}: ${nextw.toDevString()}`);
                        wb.nextConnection.connect(nextw.previousConnection);
                    }
                }
            }
            function markUsed(b) {
                b.__pxt_used = true;
            }
            function isUsed(b) {
                return !!b.__pxt_used;
            }
            function cloneIntoDiff(b) {
                const bdom = Blockly.Xml.blockToDom(b, false);
                const b2 = Blockly.Xml.domToBlock(bdom, ws);
                // disconnect
                if (b2.nextConnection && b2.nextConnection.targetConnection)
                    b2.nextConnection.disconnect();
                if (b2.previousConnection && b2.previousConnection.targetConnection)
                    b2.previousConnection.disconnect();
                return b2;
            }
            function forceRender(b) {
                const a = b;
                a.rendered = false;
                b.inputList.forEach(i => i.fieldRow.forEach(f => {
                    f.init();
                    if (f.borderRect_) {
                        f.borderRect_.setAttribute('fill', b.getColour());
                        f.borderRect_.setAttribute('stroke', b.getColourTertiary());
                    }
                }));
            }
            function done(b) {
                b.getDescendants(false).forEach(t => { delete todoBlocks[t.id]; markUsed(t); });
            }
            function findUsed(b) {
                return !!b.getDescendants(false).find(c => isUsed(c));
            }
            function logTodo(msg) {
                log(`${msg}:`, pxt.Util.values(todoBlocks).map(b => b.toDevString()));
            }
            function moved(b) {
                const oldb = oldWs.getBlockById(b.id); // extra block created in added step
                if (!oldb)
                    return false;
                const newPrevious = b.getPreviousBlock();
                // connection already already processed
                if (newPrevious && !todoBlocks[newPrevious.id])
                    return false;
                const newNext = b.getNextBlock();
                // already processed
                if (newNext && !todoBlocks[newNext.id])
                    return false;
                const oldPrevious = oldb.getPreviousBlock();
                if (!oldPrevious && !newPrevious)
                    return false; // no connection
                if (!!oldPrevious != !!newPrevious // new connection
                    || oldPrevious.id != newPrevious.id) // new connected blocks
                    return true;
                const oldNext = oldb.getNextBlock();
                if (!oldNext && !newNext)
                    return false; // no connection
                if (!!oldNext != !!newNext // new connection
                    || oldNext.id != newNext.id) // new connected blocks
                    return true;
                return false;
            }
            function changed(b) {
                let oldb = oldWs.getBlockById(b.id); // extra block created in added step
                if (!oldb)
                    return false;
                // normalize
                //oldb = copyToTrashWs(oldb);
                const oldText = normalizedDom(oldb);
                //b = copyToTrashWs(b);
                const newText = normalizedDom(b);
                if (oldText != newText) {
                    log(`old ${oldb.toDevString()}`, oldText);
                    log(`new ${b.toDevString()}`, newText);
                    return true;
                }
                // not changed!
                return false;
            }
            function unmodified(b) {
                b.setColour(UNMODIFIED_COLOR);
                forceRender(b);
                if (options.statementsOnly) {
                    // mark all nested reporters as unmodified
                    (b.inputList || [])
                        .map(input => input.type == Blockly.INPUT_VALUE && input.connection && input.connection.targetBlock())
                        .filter(argBlock => !!argBlock)
                        .forEach(argBlock => unmodified(argBlock));
                }
            }
        }
        function mergeXml(xmlA, xmlO, xmlB) {
            if (xmlA == xmlO)
                return xmlB;
            if (xmlB == xmlO)
                return xmlA;
            // TODO merge
            return undefined;
        }
        blocks.mergeXml = mergeXml;
        function normalizedDom(b, keepChildren) {
            const dom = Blockly.Xml.blockToDom(b, true);
            normalizeAttributes(dom);
            visDom(dom, (e) => {
                normalizeAttributes(e);
                if (!keepChildren) {
                    if (e.localName == "next")
                        e.remove(); // disconnect or unplug not working propertly
                    else if (e.localName == "statement")
                        e.remove();
                    else if (e.localName == "shadow") // ignore internal nodes
                        e.remove();
                }
            });
            return Blockly.Xml.domToText(dom);
        }
        function normalizeAttributes(e) {
            e.removeAttribute("id");
            e.removeAttribute("x");
            e.removeAttribute("y");
            e.removeAttribute("deletable");
            e.removeAttribute("editable");
            e.removeAttribute("movable");
        }
        function visDom(el, f) {
            if (!el)
                return;
            f(el);
            for (const child of pxt.Util.toArray(el.children))
                visDom(child, f);
        }
        function decompiledDiffAsync(oldTs, oldResp, newTs, newResp, options = {}) {
            const log = logger();
            const oldXml = oldResp.outfiles[pxt.MAIN_BLOCKS];
            let newXml = newResp.outfiles[pxt.MAIN_BLOCKS];
            log(oldXml);
            log(newXml);
            // compute diff of typescript sources
            const diffLines = pxt.diff.compute(oldTs, newTs, {
                ignoreWhitespace: true,
                full: true
            });
            log(diffLines);
            // build old -> new lines mapping
            const newids = {};
            let oldLineStart = 0;
            let newLineStart = 0;
            diffLines.forEach((ln, index) => {
                // moving cursors
                const marker = ln[0];
                const line = ln.substr(2);
                let lineLength = line.length;
                switch (marker) {
                    case "-": // removed
                        oldLineStart += lineLength + 1;
                        break;
                    case "+": // added
                        newLineStart += lineLength + 1;
                        break;
                    default: // unchanged
                        // skip leading white space
                        const lw = /^\s+/.exec(line);
                        if (lw) {
                            const lwl = lw[0].length;
                            oldLineStart += lwl;
                            newLineStart += lwl;
                            lineLength -= lwl;
                        }
                        // find block ids mapped to the ranges
                        const newid = pxt.blocks.findBlockIdByPosition(newResp.blockSourceMap, {
                            start: newLineStart,
                            length: lineLength
                        });
                        if (newid && !newids[newid]) {
                            const oldid = pxt.blocks.findBlockIdByPosition(oldResp.blockSourceMap, {
                                start: oldLineStart,
                                length: lineLength
                            });
                            // patch workspace
                            if (oldid) {
                                log(ln);
                                log(`id ${oldLineStart}:${line.length}>${oldid} ==> ${newLineStart}:${line.length}>${newid}`);
                                newids[newid] = oldid;
                                newXml = newXml.replace(newid, oldid);
                            }
                        }
                        oldLineStart += lineLength + 1;
                        newLineStart += lineLength + 1;
                        break;
                }
            });
            // parse workspacews
            const oldWs = pxt.blocks.loadWorkspaceXml(oldXml, true);
            const newWs = pxt.blocks.loadWorkspaceXml(newXml, true);
            options.statementsOnly = true; // no info on expression diffs
            return diffWorkspace(oldWs, newWs, options);
        }
        blocks.decompiledDiffAsync = decompiledDiffAsync;
    })(blocks = pxt.blocks || (pxt.blocks = {}));
})(pxt || (pxt = {}));
///<reference path='../localtypings/pxtblockly.d.ts'/>
/// <reference path="../built/pxtlib.d.ts" />
var pxt;
(function (pxt) {
    var blocks;
    (function (blocks_2) {
        /**
         * Converts a DOM into workspace without triggering any Blockly event. Returns the new block ids
         * @param dom
         * @param workspace
         */
        function domToWorkspaceNoEvents(dom, workspace) {
            pxt.tickEvent(`blocks.domtow`);
            let newBlockIds = [];
            try {
                Blockly.Events.disable();
                newBlockIds = Blockly.Xml.domToWorkspace(dom, workspace);
                applyMetaComments(workspace);
            }
            catch (e) {
                pxt.reportException(e);
            }
            finally {
                Blockly.Events.enable();
            }
            return newBlockIds;
        }
        blocks_2.domToWorkspaceNoEvents = domToWorkspaceNoEvents;
        function applyMetaComments(workspace) {
            // process meta comments
            // @highlight -> highlight block
            workspace.getAllBlocks(false)
                .filter(b => !!b.getCommentText())
                .forEach(b => {
                var _a, _b;
                const c = b.getCommentText();
                if (/@highlight/.test(c)) {
                    const cc = c.replace(/@highlight/g, '').trim();
                    b.setCommentText(cc || null);
                    (_b = (_a = workspace).highlightBlock) === null || _b === void 0 ? void 0 : _b.call(_a, b.id);
                }
            });
        }
        function clearWithoutEvents(workspace) {
            pxt.tickEvent(`blocks.clear`);
            if (!workspace)
                return;
            try {
                Blockly.Events.disable();
                workspace.clear();
                workspace.clearUndo();
            }
            finally {
                Blockly.Events.enable();
            }
        }
        blocks_2.clearWithoutEvents = clearWithoutEvents;
        // Saves entire workspace, including variables, into an xml string
        function saveWorkspaceXml(ws, keepIds) {
            const xml = Blockly.Xml.workspaceToDom(ws, !keepIds);
            const text = Blockly.Xml.domToText(xml);
            return text;
        }
        blocks_2.saveWorkspaceXml = saveWorkspaceXml;
        // Saves only the blocks xml by iterating over the top blocks
        function saveBlocksXml(ws, keepIds) {
            let topBlocks = ws.getTopBlocks(false);
            return topBlocks.map(block => {
                return Blockly.Xml.domToText(Blockly.Xml.blockToDom(block, !keepIds));
            });
        }
        blocks_2.saveBlocksXml = saveBlocksXml;
        function getDirectChildren(parent, tag) {
            const res = [];
            for (let i = 0; i < parent.childNodes.length; i++) {
                const n = parent.childNodes.item(i);
                if (n.tagName === tag) {
                    res.push(n);
                }
            }
            return res;
        }
        blocks_2.getDirectChildren = getDirectChildren;
        function getBlocksWithType(parent, type) {
            return getChildrenWithAttr(parent, "block", "type", type).concat(getChildrenWithAttr(parent, "shadow", "type", type));
        }
        blocks_2.getBlocksWithType = getBlocksWithType;
        function getChildrenWithAttr(parent, tag, attr, value) {
            return pxt.Util.toArray(parent.getElementsByTagName(tag)).filter(b => b.getAttribute(attr) === value);
        }
        blocks_2.getChildrenWithAttr = getChildrenWithAttr;
        function getFirstChildWithAttr(parent, tag, attr, value) {
            const res = getChildrenWithAttr(parent, tag, attr, value);
            return res.length ? res[0] : undefined;
        }
        blocks_2.getFirstChildWithAttr = getFirstChildWithAttr;
        function loadBlocksXml(ws, text) {
            let xmlBlock = Blockly.Xml.textToDom(text);
            let block = Blockly.Xml.domToBlock(xmlBlock, ws);
            if (ws.getMetrics) {
                let metrics = ws.getMetrics();
                let blockDimensions = block.getHeightWidth();
                block.moveBy(metrics.viewLeft + (metrics.viewWidth / 2) - (blockDimensions.width / 2), metrics.viewTop + (metrics.viewHeight / 2) - (blockDimensions.height / 2));
            }
        }
        blocks_2.loadBlocksXml = loadBlocksXml;
        /**
         * Loads the xml into a off-screen workspace (not suitable for size computations)
         */
        function loadWorkspaceXml(xml, skipReport = false) {
            const workspace = new Blockly.Workspace();
            try {
                const dom = Blockly.Xml.textToDom(xml);
                pxt.blocks.domToWorkspaceNoEvents(dom, workspace);
                return workspace;
            }
            catch (e) {
                if (!skipReport)
                    pxt.reportException(e);
                return null;
            }
        }
        blocks_2.loadWorkspaceXml = loadWorkspaceXml;
        function patchFloatingBlocks(dom, info) {
            const onstarts = getBlocksWithType(dom, ts.pxtc.ON_START_TYPE);
            let onstart = onstarts.length ? onstarts[0] : undefined;
            if (onstart) { // nothing to do
                onstart.removeAttribute("deletable");
                return;
            }
            let newnodes = [];
            const blocks = info.blocksById;
            // walk top level blocks
            let node = dom.firstElementChild;
            let insertNode = undefined;
            while (node) {
                const nextNode = node.nextElementSibling;
                // does this block is disable or have s nested statement block?
                const nodeType = node.getAttribute("type");
                if (!node.getAttribute("disabled") && !node.getElementsByTagName("statement").length
                    && (pxt.blocks.buildinBlockStatements[nodeType] ||
                        (blocks[nodeType] && blocks[nodeType].retType == "void" && !blocks_2.hasArrowFunction(blocks[nodeType])))) {
                    // old block, needs to be wrapped in onstart
                    if (!insertNode) {
                        insertNode = dom.ownerDocument.createElement("statement");
                        insertNode.setAttribute("name", "HANDLER");
                        if (!onstart) {
                            onstart = dom.ownerDocument.createElement("block");
                            onstart.setAttribute("type", ts.pxtc.ON_START_TYPE);
                            newnodes.push(onstart);
                        }
                        onstart.appendChild(insertNode);
                        insertNode.appendChild(node);
                        node.removeAttribute("x");
                        node.removeAttribute("y");
                        insertNode = node;
                    }
                    else {
                        // event, add nested statement
                        const next = dom.ownerDocument.createElement("next");
                        next.appendChild(node);
                        insertNode.appendChild(next);
                        node.removeAttribute("x");
                        node.removeAttribute("y");
                        insertNode = node;
                    }
                }
                node = nextNode;
            }
            newnodes.forEach(n => dom.appendChild(n));
        }
        /**
         * Patch to transform old function blocks to new ones, and rename child nodes
         */
        function patchFunctionBlocks(dom, info) {
            let functionNodes = pxt.U.toArray(dom.querySelectorAll("block[type=procedures_defnoreturn]"));
            functionNodes.forEach(node => {
                node.setAttribute("type", "function_definition");
                node.querySelector("field[name=NAME]").setAttribute("name", "function_name");
            });
            let functionCallNodes = pxt.U.toArray(dom.querySelectorAll("block[type=procedures_callnoreturn]"));
            functionCallNodes.forEach(node => {
                node.setAttribute("type", "function_call");
                node.querySelector("field[name=NAME]").setAttribute("name", "function_name");
            });
        }
        function importXml(pkgTargetVersion, xml, info, skipReport = false) {
            try {
                // If it's the first project we're importing in the session, Blockly is not initialized
                // and blocks haven't been injected yet
                pxt.blocks.initializeAndInject(info);
                const parser = new DOMParser();
                const doc = parser.parseFromString(xml, "application/xml");
                const upgrades = pxt.patching.computePatches(pkgTargetVersion);
                if (upgrades) {
                    // patch block types
                    upgrades.filter(up => up.type == "blockId")
                        .forEach(up => Object.keys(up.map).forEach(type => {
                        getBlocksWithType(doc, type)
                            .forEach(blockNode => {
                            blockNode.setAttribute("type", up.map[type]);
                            pxt.debug(`patched block ${type} -> ${up.map[type]}`);
                        });
                    }));
                    // patch block value
                    upgrades.filter(up => up.type == "blockValue")
                        .forEach(up => Object.keys(up.map).forEach(k => {
                        const m = k.split('.');
                        const type = m[0];
                        const name = m[1];
                        getBlocksWithType(doc, type)
                            .reduce((prev, current) => prev.concat(getDirectChildren(current, "value")), [])
                            .forEach(blockNode => {
                            blockNode.setAttribute("name", up.map[k]);
                            pxt.debug(`patched block value ${k} -> ${up.map[k]}`);
                        });
                    }));
                    // patch enum variables
                    upgrades.filter(up => up.type == "userenum")
                        .forEach(up => Object.keys(up.map).forEach(k => {
                        getChildrenWithAttr(doc, "variable", "type", k).forEach(el => {
                            el.setAttribute("type", up.map[k]);
                            pxt.debug(`patched enum variable type ${k} -> ${up.map[k]}`);
                        });
                    }));
                }
                // Blockly doesn't allow top-level shadow blocks. We've had bugs in the past where shadow blocks
                // have ended up as top-level blocks, so promote them to regular blocks just in case
                const shadows = getDirectChildren(doc.children.item(0), "shadow");
                for (const shadow of shadows) {
                    const block = doc.createElement("block");
                    shadow.getAttributeNames().forEach(attr => block.setAttribute(attr, shadow.getAttribute(attr)));
                    for (let j = 0; j < shadow.childNodes.length; j++) {
                        block.appendChild(shadow.childNodes.item(j));
                    }
                    shadow.replaceWith(block);
                }
                // build upgrade map
                const enums = {};
                Object.keys(info.apis.byQName).forEach(k => {
                    let api = info.apis.byQName[k];
                    if (api.kind == 7 /* EnumMember */)
                        enums[api.namespace + '.' + (api.attributes.blockImportId || api.attributes.block || api.attributes.blockId || api.name)]
                            = api.namespace + '.' + api.name;
                });
                // walk through blocks and patch enums
                const blocks = doc.getElementsByTagName("block");
                for (let i = 0; i < blocks.length; ++i)
                    patchBlock(info, enums, blocks[i]);
                // patch floating blocks
                patchFloatingBlocks(doc.documentElement, info);
                // patch function blocks
                patchFunctionBlocks(doc.documentElement, info);
                // apply extension patches
                if (pxt.blocks.extensionBlocklyPatch)
                    pxt.blocks.extensionBlocklyPatch(pkgTargetVersion, doc.documentElement);
                // serialize and return
                return new XMLSerializer().serializeToString(doc);
            }
            catch (e) {
                if (!skipReport)
                    pxt.reportException(e);
                return xml;
            }
        }
        blocks_2.importXml = importXml;
        function patchBlock(info, enums, block) {
            var _a;
            let type = block.getAttribute("type");
            let b = Blockly.Blocks[type];
            let symbol = blocks_2.blockSymbol(type);
            if (!symbol || !b)
                return;
            let comp = blocks_2.compileInfo(symbol);
            (_a = symbol.parameters) === null || _a === void 0 ? void 0 : _a.forEach((p, i) => {
                let ptype = info.apis.byQName[p.type];
                if (ptype && ptype.kind == 6 /* Enum */) {
                    let field = getFirstChildWithAttr(block, "field", "name", comp.actualNameToParam[p.name].definitionName);
                    if (field) {
                        let en = enums[ptype.name + '.' + field.textContent];
                        if (en)
                            field.textContent = en;
                    }
                    /*
    <block type="device_button_event" x="92" y="77">
        <field name="NAME">Button.AB</field>
      </block>
                      */
                }
            });
        }
    })(blocks = pxt.blocks || (pxt.blocks = {}));
})(pxt || (pxt = {}));
var pxt;
(function (pxt) {
    var blocks;
    (function (blocks_3) {
        var layout;
        (function (layout) {
            function patchBlocksFromOldWorkspace(blockInfo, oldWs, newXml) {
                const newWs = pxt.blocks.loadWorkspaceXml(newXml, true);
                // position blocks
                alignBlocks(blockInfo, oldWs, newWs);
                // inject disabled blocks
                return injectDisabledBlocks(oldWs, newWs);
            }
            layout.patchBlocksFromOldWorkspace = patchBlocksFromOldWorkspace;
            function injectDisabledBlocks(oldWs, newWs) {
                const oldDom = Blockly.Xml.workspaceToDom(oldWs, true);
                const newDom = Blockly.Xml.workspaceToDom(newWs, true);
                pxt.Util.toArray(oldDom.childNodes)
                    .filter((n) => n.nodeType == Node.ELEMENT_NODE && n.localName == "block" && n.getAttribute("disabled") == "true")
                    .forEach(n => newDom.appendChild(newDom.ownerDocument.importNode(n, true)));
                const updatedXml = Blockly.Xml.domToText(newDom);
                return updatedXml;
            }
            function alignBlocks(blockInfo, oldWs, newWs) {
                let env;
                let newBlocks; // support for multiple events with similar name
                oldWs.getTopBlocks(false).filter(ob => ob.isEnabled())
                    .forEach(ob => {
                    const otp = ob.xy_;
                    if (otp && otp.x != 0 && otp.y != 0) {
                        if (!env) {
                            env = pxt.blocks.mkEnv(oldWs, blockInfo);
                            newBlocks = {};
                            newWs.getTopBlocks(false).forEach(b => {
                                const nkey = pxt.blocks.callKey(env, b);
                                const nbs = newBlocks[nkey] || [];
                                nbs.push(b);
                                newBlocks[nkey] = nbs;
                            });
                        }
                        const oldKey = pxt.blocks.callKey(env, ob);
                        const newBlock = (newBlocks[oldKey] || []).shift();
                        if (newBlock)
                            newBlock.xy_ = otp.clone();
                    }
                });
            }
            /**
             * Splits a blockly SVG AFTER a vertical layout. This function relies on the ordering
             * of blocks / comments to get as getTopBlock(true)/getTopComment(true)
             */
            function splitSvg(svg, ws, emPixels = 18) {
                const comments = ws.getTopComments(true);
                const blocks = ws.getTopBlocks(true);
                // don't split for a single block
                if (comments.length + blocks.length < 2)
                    return svg;
                const div = document.createElement("div");
                div.className = `blocks-svg-list ${ws.getInjectionDiv().className}`;
                function extract(parentClass, otherClass, blocki, size, translate, itemClass) {
                    const svgclone = svg.cloneNode(true);
                    // collect all blocks
                    const parentSvg = svgclone.querySelector(`g.blocklyWorkspace > g.${parentClass}`);
                    const otherSvg = svgclone.querySelector(`g.blocklyWorkspace > g.${otherClass}`);
                    const blocksSvg = pxt.Util.toArray(parentSvg.querySelectorAll(`g.blocklyWorkspace > g.${parentClass} > ${itemClass ? ("." + itemClass) : "g[transform]"}`));
                    const blockSvg = blocksSvg.splice(blocki, 1)[0];
                    if (!blockSvg) {
                        // seems like no blocks were generated
                        pxt.log(`missing block, did block failed to load?`);
                        return;
                    }
                    // remove all but the block we care about
                    blocksSvg.filter(g => g != blockSvg)
                        .forEach(g => {
                        g.parentNode.removeChild(g);
                    });
                    // clear transform, remove other group
                    parentSvg.removeAttribute("transform");
                    otherSvg.parentNode.removeChild(otherSvg);
                    // patch size
                    blockSvg.setAttribute("transform", `translate(${translate.x}, ${translate.y})`);
                    const width = (size.width / emPixels) + "em";
                    const height = (size.height / emPixels) + "em";
                    svgclone.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
                    svgclone.style.width = width;
                    svgclone.style.height = height;
                    svgclone.setAttribute("width", width);
                    svgclone.setAttribute("height", height);
                    div.appendChild(svgclone);
                }
                comments.forEach((comment, commenti) => extract('blocklyBubbleCanvas', 'blocklyBlockCanvas', commenti, comment.getHeightWidth(), { x: 0, y: 0 }, "blocklyComment"));
                blocks.forEach((block, blocki) => {
                    const size = block.getHeightWidth();
                    const translate = { x: 0, y: 0 };
                    if (block.getStartHat()) {
                        size.height += emPixels;
                        translate.y += emPixels;
                    }
                    extract('blocklyBlockCanvas', 'blocklyBubbleCanvas', blocki, size, translate);
                });
                return div;
            }
            layout.splitSvg = splitSvg;
            function verticalAlign(ws, emPixels) {
                let y = 0;
                let comments = ws.getTopComments(true);
                comments.forEach(comment => {
                    comment.moveBy(0, y);
                    y += comment.getHeightWidth().height;
                    y += emPixels; //buffer
                });
                let blocks = ws.getTopBlocks(true);
                blocks.forEach((block, bi) => {
                    // TODO: REMOVE THIS WHEN FIXED IN PXT-BLOCKLY
                    if (block.getStartHat())
                        y += emPixels; // hat height
                    block.moveBy(0, y);
                    y += block.getHeightWidth().height;
                    y += emPixels; //buffer
                });
            }
            layout.verticalAlign = verticalAlign;
            function setCollapsedAll(ws, collapsed) {
                ws.getTopBlocks(false)
                    .filter(b => b.isEnabled())
                    .forEach(b => b.setCollapsed(collapsed));
            }
            layout.setCollapsedAll = setCollapsedAll;
            // Workspace margins
            const marginx = 20;
            const marginy = 20;
            function flow(ws, opts) {
                if (opts) {
                    if (opts.useViewWidth) {
                        const metrics = ws.getMetrics();
                        // Only use the width if in portrait, otherwise the blocks are too spread out
                        if (metrics.viewHeight > metrics.viewWidth) {
                            flowBlocks(ws.getTopComments(true), ws.getTopBlocks(true), undefined, metrics.viewWidth);
                            ws.scroll(marginx, marginy);
                            return;
                        }
                    }
                    flowBlocks(ws.getTopComments(true), ws.getTopBlocks(true), opts.ratio);
                }
                else {
                    flowBlocks(ws.getTopComments(true), ws.getTopBlocks(true));
                }
                ws.scroll(marginx, marginy);
            }
            layout.flow = flow;
            function screenshotEnabled() {
                return !pxt.BrowserUtils.isIE()
                    && !pxt.BrowserUtils.isUwpEdge(); // TODO figure out why screenshots are not working in UWP; disable for now
            }
            layout.screenshotEnabled = screenshotEnabled;
            function screenshotAsync(ws, pixelDensity, encodeBlocks) {
                return toPngAsync(ws, pixelDensity, encodeBlocks);
            }
            layout.screenshotAsync = screenshotAsync;
            function toPngAsync(ws, pixelDensity, encodeBlocks) {
                let blockSnippet;
                if (encodeBlocks) {
                    blockSnippet = {
                        target: pxt.appTarget.id,
                        versions: pxt.appTarget.versions,
                        xml: pxt.blocks.saveBlocksXml(ws).map(text => pxt.Util.htmlEscape(text))
                    };
                }
                const density = (pixelDensity | 0) || 4;
                return toSvgAsync(ws, density)
                    .then(sg => {
                    if (!sg)
                        return Promise.resolve(undefined);
                    return pxt.BrowserUtils.encodeToPngAsync(sg.xml, {
                        width: sg.width,
                        height: sg.height,
                        pixelDensity: density,
                        text: encodeBlocks ? JSON.stringify(blockSnippet, null, 2) : null
                    });
                }).catch(e => {
                    pxt.reportException(e);
                    return undefined;
                });
            }
            layout.toPngAsync = toPngAsync;
            const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
            const MAX_AREA = 120000000; // https://github.com/jhildenbiddle/canvas-size
            function toSvgAsync(ws, pixelDensity) {
                if (!ws)
                    return Promise.resolve(undefined);
                const metrics = ws.getBlocksBoundingBox();
                const sg = ws.getParentSvg().cloneNode(true);
                cleanUpBlocklySvg(sg);
                let width = metrics.right - metrics.left;
                let height = metrics.bottom - metrics.top;
                let scale = 1;
                const area = width * height * Math.pow(pixelDensity, 2);
                if (area > MAX_AREA) {
                    scale = Math.sqrt(MAX_AREA / area);
                }
                return blocklyToSvgAsync(sg, metrics.left, metrics.top, width, height, scale);
            }
            layout.toSvgAsync = toSvgAsync;
            function serializeNode(sg) {
                return serializeSvgString(new XMLSerializer().serializeToString(sg));
            }
            layout.serializeNode = serializeNode;
            function serializeSvgString(xmlString) {
                return xmlString
                    .replace(new RegExp('&nbsp;', 'g'), '&#160;'); // Replace &nbsp; with &#160; as a workaround for having nbsp missing from SVG xml
            }
            layout.serializeSvgString = serializeSvgString;
            function cleanUpBlocklySvg(svg) {
                pxt.BrowserUtils.removeClass(svg, "blocklySvg");
                pxt.BrowserUtils.addClass(svg, "blocklyPreview pxt-renderer classic-theme");
                // Remove background elements
                pxt.U.toArray(svg.querySelectorAll('.blocklyMainBackground,.blocklyScrollbarBackground'))
                    .forEach(el => { if (el)
                    el.parentNode.removeChild(el); });
                // Remove connection indicator elements
                pxt.U.toArray(svg.querySelectorAll('.blocklyConnectionIndicator,.blocklyInputConnectionIndicator'))
                    .forEach(el => { if (el)
                    el.parentNode.removeChild(el); });
                svg.removeAttribute('width');
                svg.removeAttribute('height');
                pxt.U.toArray(svg.querySelectorAll('.blocklyBlockCanvas,.blocklyBubbleCanvas'))
                    .forEach(el => el.removeAttribute('transform'));
                // In order to get the Blockly comment's text area to serialize properly they have to have names
                const parser = new DOMParser();
                pxt.U.toArray(svg.querySelectorAll('.blocklyCommentTextarea'))
                    .forEach(el => {
                    const dom = parser.parseFromString('<!doctype html><body>' + pxt.docs.html2Quote(el.value), 'text/html');
                    el.textContent = dom.body.textContent;
                });
                return svg;
            }
            layout.cleanUpBlocklySvg = cleanUpBlocklySvg;
            function blocklyToSvgAsync(sg, x, y, width, height, scale) {
                if (!sg.childNodes[0])
                    return Promise.resolve(undefined);
                sg.removeAttribute("width");
                sg.removeAttribute("height");
                sg.removeAttribute("transform");
                let renderWidth = Math.round(width * (scale || 1));
                let renderHeight = Math.round(height * (scale || 1));
                const xmlString = serializeNode(sg)
                    .replace(/^\s*<svg[^>]+>/i, '')
                    .replace(/<\/svg>\s*$/i, ''); // strip out svg tag
                const svgXml = `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="${XLINK_NAMESPACE}" width="${renderWidth}" height="${renderHeight}" viewBox="${x} ${y} ${width} ${height}" class="pxt-renderer">${xmlString}</svg>`;
                const xsg = new DOMParser().parseFromString(svgXml, "image/svg+xml");
                const cssLink = xsg.createElementNS("http://www.w3.org/1999/xhtml", "style");
                const isRtl = pxt.Util.isUserLanguageRtl();
                const customCssHref = document.getElementById(`style-${isRtl ? 'rtl' : ''}blockly.css`).href;
                const semanticCssHref = pxt.Util.toArray(document.head.getElementsByTagName("link"))
                    .filter(l => pxt.Util.endsWith(l.getAttribute("href"), "semantic.css"))[0].href;
                return Promise.all([pxt.BrowserUtils.loadAjaxAsync(customCssHref), pxt.BrowserUtils.loadAjaxAsync(semanticCssHref)])
                    .then((customCss) => {
                    var _a, _b;
                    const blocklySvg = pxt.Util.toArray(document.head.querySelectorAll("style"))
                        .filter((el) => /\.blocklySvg/.test(el.innerText))[0];
                    // Custom CSS injected directly into the DOM by Blockly
                    customCss.unshift(((_a = document.getElementById(`blockly-common-style`)) === null || _a === void 0 ? void 0 : _a.innerText) || "");
                    customCss.unshift(((_b = document.getElementById(`blockly-renderer-style-pxt`)) === null || _b === void 0 ? void 0 : _b.innerText) || "");
                    // CSS may contain <, > which need to be stored in CDATA section
                    const cssString = (blocklySvg ? blocklySvg.innerText : "") + '\n\n' + customCss.map(el => el + '\n\n');
                    cssLink.appendChild(xsg.createCDATASection(cssString));
                    xsg.documentElement.insertBefore(cssLink, xsg.documentElement.firstElementChild);
                    return expandImagesAsync(xsg)
                        .then(() => convertIconsToPngAsync(xsg))
                        .then(() => {
                        return {
                            width: renderWidth,
                            height: renderHeight,
                            svg: serializeNode(xsg).replace('<style xmlns="http://www.w3.org/1999/xhtml">', '<style>'),
                            xml: documentToSvg(xsg),
                            css: cssString
                        };
                    });
                });
            }
            layout.blocklyToSvgAsync = blocklyToSvgAsync;
            function documentToSvg(xsg) {
                const xml = new XMLSerializer().serializeToString(xsg);
                const data = "data:image/svg+xml;base64," + ts.pxtc.encodeBase64(unescape(encodeURIComponent(xml)));
                return data;
            }
            layout.documentToSvg = documentToSvg;
            let imageXLinkCache;
            function expandImagesAsync(xsg) {
                if (!imageXLinkCache)
                    imageXLinkCache = {};
                const images = xsg.getElementsByTagName("image");
                const p = pxt.Util.toArray(images)
                    .filter(image => {
                    const href = image.getAttributeNS(XLINK_NAMESPACE, "href");
                    return href && !/^data:/.test(href);
                })
                    .map(img => img)
                    .map((image) => {
                    const href = image.getAttributeNS(XLINK_NAMESPACE, "href");
                    let dataUri = imageXLinkCache[href];
                    return (dataUri ? Promise.resolve(imageXLinkCache[href])
                        : pxt.BrowserUtils.loadImageAsync(image.getAttributeNS(XLINK_NAMESPACE, "href"))
                            .then((img) => {
                            const cvs = document.createElement("canvas");
                            const ctx = cvs.getContext("2d");
                            let w = img.width;
                            let h = img.height;
                            cvs.width = w;
                            cvs.height = h;
                            ctx.drawImage(img, 0, 0, w, h, 0, 0, cvs.width, cvs.height);
                            imageXLinkCache[href] = dataUri = cvs.toDataURL("image/png");
                            return dataUri;
                        }).catch(e => {
                            // ignore load error
                            pxt.debug(`svg render: failed to load ${href}`);
                            return "";
                        }))
                        .then(href => { image.setAttributeNS(XLINK_NAMESPACE, "href", href); });
                });
                return Promise.all(p).then(() => { });
            }
            let imageIconCache;
            function convertIconsToPngAsync(xsg) {
                if (!imageIconCache)
                    imageIconCache = {};
                if (!pxt.BrowserUtils.isEdge())
                    return Promise.resolve();
                const images = xsg.getElementsByTagName("image");
                const p = pxt.Util.toArray(images)
                    .filter(image => /^data:image\/svg\+xml/.test(image.getAttributeNS(XLINK_NAMESPACE, "href")))
                    .map(img => img)
                    .map((image) => {
                    const svgUri = image.getAttributeNS(XLINK_NAMESPACE, "href");
                    const width = parseInt(image.getAttribute("width").replace(/[^0-9]/g, ""));
                    const height = parseInt(image.getAttribute("height").replace(/[^0-9]/g, ""));
                    let pngUri = imageIconCache[svgUri];
                    return (pngUri ? Promise.resolve(pngUri)
                        : pxt.BrowserUtils.encodeToPngAsync(svgUri, { width, height, pixelDensity: 2 }))
                        .then(href => {
                        imageIconCache[svgUri] = href;
                        image.setAttributeNS(XLINK_NAMESPACE, "href", href);
                    });
                });
                return Promise.all(p).then(() => { });
            }
            function flowBlocks(comments, blocks, ratio = 1.62, maxWidth) {
                // Margin between blocks and their comments
                const innerGroupMargin = 13;
                // Margin between groups of blocks and comments
                const outerGroupMargin = 45;
                const groups = [];
                const commentMap = {};
                comments.forEach(comment => {
                    const ref = comment.data;
                    if (ref != undefined) {
                        commentMap[ref] = comment;
                    }
                });
                let onStart;
                // Sort so that on-start is first, events are second, functions are third, and disabled blocks are last
                blocks.sort((a, b) => {
                    if (a.isEnabled() === b.isEnabled()) {
                        if (a.type === b.type)
                            return 0;
                        else if (a.type === "function_definition")
                            return 1;
                        else if (b.type === "function_definition")
                            return -1;
                        else
                            return a.type.localeCompare(b.type);
                    }
                    else if (a.isEnabled())
                        return -1;
                    else
                        return 1;
                });
                blocks.forEach(block => {
                    const refs = blocks_3.getBlockData(block).commentRefs;
                    if (refs.length) {
                        const children = [];
                        for (let i = 0; i < refs.length; i++) {
                            const comment = commentMap[refs[i]];
                            if (comment) {
                                children.push(formattable(comment));
                                delete commentMap[refs[i]];
                            }
                        }
                        if (children.length) {
                            groups.push({ value: block, width: -1, height: -1, children });
                            return;
                        }
                    }
                    const f = formattable(block);
                    if (!onStart && block.isEnabled() && block.type === pxtc.ON_START_TYPE) { // there might be duplicate on-start blocks
                        onStart = f;
                    }
                    else {
                        groups.push(f);
                    }
                });
                if (onStart) {
                    groups.unshift(onStart);
                }
                // Collect the comments that were not linked to a top-level block
                Object.keys(commentMap).sort((a, b) => {
                    // These are strings of integers (eg "0", "17", etc.) with no duplicates
                    if (a.length === b.length) {
                        return a > b ? -1 : 1;
                    }
                    else {
                        return a.length > b.length ? -1 : 1;
                    }
                }).forEach(key => {
                    if (commentMap[key]) {
                        // Comments go at the end after disabled blocks
                        groups.push(formattable(commentMap[key]));
                    }
                });
                comments.forEach(comment => {
                    const ref = comment.data;
                    if (ref == undefined) {
                        groups.push(formattable(comment));
                    }
                });
                let surfaceArea = 0;
                for (let i = 0; i < groups.length; i++) {
                    const group = groups[i];
                    if (group.children) {
                        const valueDimensions = group.value.getHeightWidth();
                        group.x = 0;
                        group.y = 0;
                        let x = valueDimensions.width + innerGroupMargin;
                        let y = 0;
                        // Lay comments out to the right of the parent node
                        for (let j = 0; j < group.children.length; j++) {
                            const child = group.children[j];
                            child.x = x;
                            child.y = y;
                            y += child.height + innerGroupMargin;
                            group.width = Math.max(group.width, x + child.width);
                        }
                        group.height = Math.max(y - innerGroupMargin, valueDimensions.height);
                    }
                    surfaceArea += (group.height + innerGroupMargin) * (group.width + innerGroupMargin);
                }
                let maxx;
                if (maxWidth > marginx) {
                    maxx = maxWidth - marginx;
                }
                else {
                    maxx = Math.sqrt(surfaceArea) * ratio;
                }
                let insertx = marginx;
                let inserty = marginy;
                let rowBottom = 0;
                for (let i = 0; i < groups.length; i++) {
                    const group = groups[i];
                    if (group.children) {
                        moveFormattable(group, insertx + group.x, inserty + group.y);
                        for (let j = 0; j < group.children.length; j++) {
                            const child = group.children[j];
                            moveFormattable(child, insertx + child.x, inserty + child.y);
                        }
                    }
                    else {
                        moveFormattable(group, insertx, inserty);
                    }
                    insertx += group.width + outerGroupMargin;
                    rowBottom = Math.max(rowBottom, inserty + group.height + outerGroupMargin);
                    if (insertx > maxx) {
                        insertx = marginx;
                        inserty = rowBottom;
                    }
                }
                function moveFormattable(f, x, y) {
                    const bounds = f.value.getBoundingRectangle();
                    f.value.moveBy(x - bounds.left, y - bounds.top);
                }
            }
            function formattable(entity) {
                const hw = entity.getHeightWidth();
                return { value: entity, height: hw.height, width: hw.width };
            }
        })(layout = blocks_3.layout || (blocks_3.layout = {}));
    })(blocks = pxt.blocks || (pxt.blocks = {}));
})(pxt || (pxt = {}));
/// <reference path="../localtypings/blockly.d.ts" />
/// <reference path="../built/pxtlib.d.ts" />
var pxt;
(function (pxt) {
    var blocks;
    (function (blocks_4) {
        const typeDefaults = {
            "string": {
                field: "TEXT",
                block: "text",
                defaultValue: ""
            },
            "number": {
                field: "NUM",
                block: "math_number",
                defaultValue: "0"
            },
            "boolean": {
                field: "BOOL",
                block: "logic_boolean",
                defaultValue: "false"
            },
            "Array": {
                field: "VAR",
                block: "variables_get",
                defaultValue: "list"
            }
        };
        // Add numbers before input names to prevent clashes with the ones added by BlocklyLoader
        blocks_4.optionalDummyInputPrefix = "0_optional_dummy";
        blocks_4.optionalInputWithFieldPrefix = "0_optional_field";
        // Matches arrays
        function isArrayType(type) {
            const arrayTypeRegex = /^(?:Array<(.+)>)|(?:(.+)\[\])|(?:\[.+\])$/;
            let parsed = arrayTypeRegex.exec(type);
            if (parsed) {
                // Is an array, returns what type it is an array of
                if (parsed[1]) {
                    // Is an array with form Array<type>
                    return parsed[1];
                }
                else {
                    // Is an array with form type[]
                    return parsed[2];
                }
            }
            else {
                // Not an array
                return undefined;
            }
        }
        blocks_4.isArrayType = isArrayType;
        // Matches tuples
        function isTupleType(type) {
            const tupleTypeRegex = /^\[(.+)\]$/;
            let parsed = tupleTypeRegex.exec(type);
            if (parsed) {
                // Returns an array containing the types of the tuple
                return parsed[1].split(/,\s*/);
            }
            else {
                // Not a tuple
                return undefined;
            }
        }
        blocks_4.isTupleType = isTupleType;
        const primitiveTypeRegex = /^(string|number|boolean)$/;
        // list of built-in blocks, should be touched.
        let _builtinBlocks;
        function builtinBlocks() {
            if (!_builtinBlocks) {
                _builtinBlocks = {};
                Object.keys(Blockly.Blocks)
                    .forEach(k => _builtinBlocks[k] = { block: Blockly.Blocks[k] });
            }
            return _builtinBlocks;
        }
        blocks_4.builtinBlocks = builtinBlocks;
        blocks_4.buildinBlockStatements = {
            "controls_if": true,
            "controls_for": true,
            "pxt_controls_for": true,
            "controls_simple_for": true,
            "controls_repeat_ext": true,
            "pxt_controls_for_of": true,
            "controls_for_of": true,
            "variables_set": true,
            "variables_change": true,
            "device_while": true
        };
        // Cached block info from the last inject operation
        let cachedBlockInfo;
        let cachedBlocks = {};
        function blockSymbol(type) {
            let b = cachedBlocks[type];
            return b ? b.fn : undefined;
        }
        blocks_4.blockSymbol = blockSymbol;
        function createShadowValue(info, p, shadowId, defaultV) {
            defaultV = defaultV || p.defaultValue;
            shadowId = shadowId || p.shadowBlockId;
            if (!shadowId && p.range)
                shadowId = "math_number_minmax";
            let defaultValue;
            if (defaultV && defaultV.slice(0, 1) == "\"")
                defaultValue = JSON.parse(defaultV);
            else {
                defaultValue = defaultV;
            }
            if (p.type == "number" && shadowId == "value") {
                const field = document.createElement("field");
                field.setAttribute("name", p.definitionName);
                field.appendChild(document.createTextNode("0"));
                return field;
            }
            const isVariable = shadowId == "variables_get";
            const isText = shadowId == "text";
            const value = document.createElement("value");
            value.setAttribute("name", p.definitionName);
            const isArray = isArrayType(p.type);
            const shadow = document.createElement(isVariable || isArray ? "block" : "shadow");
            value.appendChild(shadow);
            const typeInfo = typeDefaults[isArray || p.type];
            shadow.setAttribute("type", shadowId || (isArray ? 'lists_create_with' : typeInfo && typeInfo.block || p.type));
            shadow.setAttribute("colour", Blockly.Colours.textField);
            if (isArray) {
                // if an array of booleans, numbers, or strings
                if (typeInfo && !shadowId) {
                    let fieldValues;
                    switch (isArray) {
                        case "number":
                            fieldValues = ["0", "1"];
                            break;
                        case "string":
                            fieldValues = ["a", "b", "c"];
                            break;
                        case "boolean":
                            fieldValues = ["FALSE", "FALSE", "FALSE"];
                            break;
                    }
                    buildArrayShadow(shadow, typeInfo.block, typeInfo.field, fieldValues);
                    return value;
                }
                else if (shadowId && defaultValue) {
                    buildArrayShadow(shadow, defaultValue);
                    return value;
                }
            }
            if (typeInfo && (!shadowId || typeInfo.block === shadowId || shadowId === "math_number_minmax")) {
                const field = document.createElement("field");
                shadow.appendChild(field);
                let fieldName;
                switch (shadowId) {
                    case "variables_get":
                        fieldName = "VAR";
                        break;
                    case "math_number_minmax":
                        fieldName = "SLIDER";
                        break;
                    default:
                        fieldName = typeInfo.field;
                        break;
                }
                field.setAttribute("name", fieldName);
                let value;
                if (p.type == "boolean") {
                    value = document.createTextNode((defaultValue || typeInfo.defaultValue).toUpperCase());
                }
                else {
                    value = document.createTextNode(defaultValue || typeInfo.defaultValue);
                }
                field.appendChild(value);
            }
            else if (defaultValue) {
                const field = document.createElement("field");
                field.textContent = defaultValue;
                if (isVariable) {
                    field.setAttribute("name", "VAR");
                    shadow.appendChild(field);
                }
                else if (isText) {
                    field.setAttribute("name", "TEXT");
                    shadow.appendChild(field);
                }
                else if (shadowId) {
                    const shadowInfo = info.blocksById[shadowId];
                    if (shadowInfo && shadowInfo.attributes._def && shadowInfo.attributes._def.parameters.length) {
                        const shadowParam = shadowInfo.attributes._def.parameters[0];
                        field.setAttribute("name", shadowParam.name);
                        shadow.appendChild(field);
                    }
                }
                else {
                    field.setAttribute("name", p.definitionName);
                    shadow.appendChild(field);
                }
            }
            let mut;
            if (p.range) {
                mut = document.createElement('mutation');
                mut.setAttribute('min', p.range.min.toString());
                mut.setAttribute('max', p.range.max.toString());
                mut.setAttribute('label', p.actualName.charAt(0).toUpperCase() + p.actualName.slice(1));
                if (p.fieldOptions) {
                    if (p.fieldOptions['step'])
                        mut.setAttribute('step', p.fieldOptions['step']);
                    if (p.fieldOptions['color'])
                        mut.setAttribute('color', p.fieldOptions['color']);
                    if (p.fieldOptions['precision'])
                        mut.setAttribute('precision', p.fieldOptions['precision']);
                }
            }
            if (p.fieldOptions) {
                if (!mut)
                    mut = document.createElement('mutation');
                mut.setAttribute(`customfield`, JSON.stringify(p.fieldOptions));
            }
            if (mut) {
                shadow.appendChild(mut);
            }
            return value;
        }
        blocks_4.createShadowValue = createShadowValue;
        function buildArrayShadow(shadow, blockType, fieldName, fieldValues) {
            const itemCount = fieldValues ? fieldValues.length : 2;
            const mut = document.createElement('mutation');
            mut.setAttribute("items", "" + itemCount);
            mut.setAttribute("horizontalafter", "" + itemCount);
            shadow.appendChild(mut);
            for (let i = 0; i < itemCount; i++) {
                const innerValue = document.createElement("value");
                innerValue.setAttribute("name", "ADD" + i);
                const innerShadow = document.createElement("shadow");
                innerShadow.setAttribute("type", blockType);
                if (fieldName) {
                    const field = document.createElement("field");
                    field.setAttribute("name", fieldName);
                    if (fieldValues) {
                        field.appendChild(document.createTextNode(fieldValues[i]));
                    }
                    innerShadow.appendChild(field);
                }
                innerValue.appendChild(innerShadow);
                shadow.appendChild(innerValue);
            }
        }
        function createFlyoutHeadingLabel(name, color, icon, iconClass) {
            const headingLabel = createFlyoutLabel(name, pxt.toolbox.convertColor(color), icon, iconClass);
            headingLabel.setAttribute('web-class', 'blocklyFlyoutHeading');
            return headingLabel;
        }
        blocks_4.createFlyoutHeadingLabel = createFlyoutHeadingLabel;
        function createFlyoutGroupLabel(name, icon, labelLineWidth, helpCallback) {
            const groupLabel = createFlyoutLabel(name, undefined, icon);
            groupLabel.setAttribute('web-class', 'blocklyFlyoutGroup');
            groupLabel.setAttribute('web-line', '1.5');
            if (labelLineWidth)
                groupLabel.setAttribute('web-line-width', labelLineWidth);
            if (helpCallback) {
                groupLabel.setAttribute('web-help-button', 'true');
                groupLabel.setAttribute('callbackKey', helpCallback);
            }
            return groupLabel;
        }
        blocks_4.createFlyoutGroupLabel = createFlyoutGroupLabel;
        function createFlyoutLabel(name, color, icon, iconClass) {
            // Add the Heading label
            let headingLabel = Blockly.utils.xml.createElement('label');
            headingLabel.setAttribute('text', name);
            if (color) {
                headingLabel.setAttribute('web-icon-color', pxt.toolbox.convertColor(color));
            }
            if (icon) {
                if (icon.length === 1) {
                    headingLabel.setAttribute('web-icon', icon);
                    if (iconClass)
                        headingLabel.setAttribute('web-icon-class', iconClass);
                }
                else {
                    headingLabel.setAttribute('web-icon-class', `blocklyFlyoutIcon${name}`);
                }
            }
            return headingLabel;
        }
        function createFlyoutButton(callbackKey, label) {
            let button = Blockly.utils.xml.createElement('button');
            button.setAttribute('text', label);
            button.setAttribute('callbackKey', callbackKey);
            return button;
        }
        blocks_4.createFlyoutButton = createFlyoutButton;
        function createToolboxBlock(info, fn, comp) {
            let parent;
            let parentInput;
            if (fn.attributes.toolboxParent) {
                const parentFn = info.blocksById[fn.attributes.toolboxParent];
                if (parentFn) {
                    parent = createToolboxBlock(info, parentFn, pxt.blocks.compileInfo(parentFn));
                    parentInput = fn.attributes.toolboxParentArgument ?
                        parent.querySelector(`value[name=${fn.attributes.toolboxParentArgument}]`) :
                        parent.querySelector(`value`);
                    if (parentInput) {
                        while (parentInput.firstChild)
                            parentInput.removeChild(parentInput.firstChild);
                    }
                    else {
                        parent = undefined;
                    }
                }
            }
            //
            // toolbox update
            //
            let block = document.createElement(parent ? "shadow" : "block");
            block.setAttribute("type", fn.attributes.blockId);
            if (fn.attributes.blockGap)
                block.setAttribute("gap", fn.attributes.blockGap);
            else if (pxt.appTarget.appTheme && pxt.appTarget.appTheme.defaultBlockGap)
                block.setAttribute("gap", pxt.appTarget.appTheme.defaultBlockGap.toString());
            if (comp.thisParameter) {
                const t = comp.thisParameter;
                block.appendChild(createShadowValue(info, t, t.shadowBlockId || "variables_get", t.defaultValue || t.definitionName));
            }
            if (fn.parameters) {
                comp.parameters.filter(pr => primitiveTypeRegex.test(pr.type)
                    || primitiveTypeRegex.test(isArrayType(pr.type))
                    || pr.shadowBlockId
                    || pr.defaultValue)
                    .forEach(pr => {
                    block.appendChild(createShadowValue(info, pr));
                });
                if (fn.attributes.draggableParameters) {
                    comp.handlerArgs.forEach(arg => {
                        // draggableParameters="variable":
                        // <value name="HANDLER_DRAG_PARAM_arg">
                        // <shadow type="variables_get_reporter">
                        //     <field name="VAR">defaultName</field>
                        // </shadow>
                        // </value>
                        // draggableParameters="reporter"
                        // <value name="HANDLER_DRAG_PARAM_arg">
                        //     <shadow type="argument_reporter_custom">
                        //         <mutation typename="Sprite"></mutation>
                        //         <field name="VALUE">mySprite</field>
                        //     </shadow>
                        // </value>
                        const useReporter = fn.attributes.draggableParameters === "reporter";
                        const value = document.createElement("value");
                        value.setAttribute("name", "HANDLER_DRAG_PARAM_" + arg.name);
                        const blockType = useReporter ? pxt.blocks.reporterTypeForArgType(arg.type) : "variables_get_reporter";
                        const shadow = document.createElement("shadow");
                        shadow.setAttribute("type", blockType);
                        if (useReporter && blockType === "argument_reporter_custom") {
                            const mutation = document.createElement("mutation");
                            mutation.setAttribute("typename", arg.type);
                            shadow.appendChild(mutation);
                        }
                        const field = document.createElement("field");
                        field.setAttribute("name", useReporter ? "VALUE" : "VAR");
                        field.textContent = pxt.Util.htmlEscape(arg.name);
                        shadow.appendChild(field);
                        value.appendChild(shadow);
                        block.appendChild(value);
                    });
                }
                else {
                    comp.handlerArgs.forEach(arg => {
                        const field = document.createElement("field");
                        field.setAttribute("name", "HANDLER_" + arg.name);
                        field.textContent = arg.name;
                        block.appendChild(field);
                    });
                }
            }
            if (parent) {
                parentInput.appendChild(block);
                return parent;
            }
            return block;
        }
        blocks_4.createToolboxBlock = createToolboxBlock;
        function injectBlocks(blockInfo) {
            cachedBlockInfo = blockInfo;
            Blockly.pxtBlocklyUtils.whitelistDraggableBlockTypes(blockInfo.blocks.filter(fn => fn.attributes.duplicateShadowOnDrag).map(fn => fn.attributes.blockId));
            // inject Blockly with all block definitions
            return blockInfo.blocks
                .map(fn => {
                const comp = blocks_4.compileInfo(fn);
                const block = createToolboxBlock(blockInfo, fn, comp);
                if (fn.attributes.blockBuiltin) {
                    pxt.Util.assert(!!builtinBlocks()[fn.attributes.blockId]);
                    const builtin = builtinBlocks()[fn.attributes.blockId];
                    builtin.symbol = fn;
                    builtin.block.codeCard = mkCard(fn, block);
                }
                else {
                    injectBlockDefinition(blockInfo, fn, comp, block);
                }
                return fn;
            });
        }
        blocks_4.injectBlocks = injectBlocks;
        function injectBlockDefinition(info, fn, comp, blockXml) {
            let id = fn.attributes.blockId;
            if (builtinBlocks()[id]) {
                pxt.reportError("blocks", 'trying to override builtin block', { "details": id });
                return false;
            }
            let hash = JSON.stringify(fn);
            if (cachedBlocks[id] && cachedBlocks[id].hash == hash) {
                return true;
            }
            if (Blockly.Blocks[fn.attributes.blockId]) {
                console.error("duplicate block definition: " + id);
                return false;
            }
            let cachedBlock = {
                hash: hash,
                fn: fn,
                block: {
                    codeCard: mkCard(fn, blockXml),
                    init: function () { initBlock(this, info, fn, comp); }
                }
            };
            if (pxt.Util.isTranslationMode()
                && pxt.blocks.promptTranslateBlock) {
                cachedBlock.block.customContextMenu = (options) => {
                    if (fn.attributes.translationId) {
                        options.push({
                            enabled: true,
                            text: lf("Translate this block"),
                            callback: function () {
                                pxt.blocks.promptTranslateBlock(id, [fn.attributes.translationId]);
                            }
                        });
                    }
                };
            }
            cachedBlocks[id] = cachedBlock;
            Blockly.Blocks[id] = cachedBlock.block;
            return true;
        }
        function newLabel(part) {
            if (part.kind === "image") {
                return iconToFieldImage(part.uri);
            }
            const txt = removeOuterSpace(part.text);
            if (!txt) {
                return undefined;
            }
            if (part.cssClass) {
                return new Blockly.FieldLabel(txt, part.cssClass);
            }
            else if (part.style.length) {
                return new pxtblockly.FieldStyledLabel(txt, {
                    bold: part.style.indexOf("bold") !== -1,
                    italics: part.style.indexOf("italics") !== -1,
                    blocksInfo: undefined
                });
            }
            else {
                return new Blockly.FieldLabel(txt, undefined);
            }
        }
        function cleanOuterHTML(el) {
            // remove IE11 junk
            return el.outerHTML.replace(/^<\?[^>]*>/, '');
        }
        function mkCard(fn, blockXml) {
            return {
                name: fn.namespace + '.' + fn.name,
                shortName: fn.name,
                description: fn.attributes.jsDoc,
                url: fn.attributes.help ? 'reference/' + fn.attributes.help.replace(/^\//, '') : undefined,
                blocksXml: `<xml xmlns="http://www.w3.org/1999/xhtml">${cleanOuterHTML(blockXml)}</xml>`,
            };
        }
        function isSubtype(apis, specific, general) {
            if (specific == general)
                return true;
            let inf = apis.byQName[specific];
            if (inf && inf.extendsTypes)
                return inf.extendsTypes.indexOf(general) >= 0;
            return false;
        }
        function initBlock(block, info, fn, comp) {
            var _a;
            const ns = (fn.attributes.blockNamespace || fn.namespace).split('.')[0];
            const instance = fn.kind == 1 /* Method */ || fn.kind == 2 /* Property */;
            const nsinfo = info.apis.byQName[ns];
            const color = 
            // blockNamespace overrides color on block
            (fn.attributes.blockNamespace && nsinfo && nsinfo.attributes.color)
                || fn.attributes.color
                || (nsinfo && nsinfo.attributes.color)
                || pxt.toolbox.getNamespaceColor(ns)
                || 255;
            const helpUrl = pxt.blocks.getHelpUrl(fn);
            if (helpUrl)
                block.setHelpUrl(helpUrl);
            block.setColour(color);
            let blockShape = Blockly.OUTPUT_SHAPE_ROUND;
            if (fn.retType == "boolean")
                blockShape = Blockly.OUTPUT_SHAPE_HEXAGONAL;
            block.setOutputShape(blockShape);
            if (fn.attributes.undeletable)
                block.setDeletable(false);
            buildBlockFromDef(fn.attributes._def);
            let hasHandler = false;
            if (fn.attributes.mutate) {
                blocks_4.addMutation(block, fn, fn.attributes.mutate);
            }
            else if (fn.attributes.defaultInstance) {
                blocks_4.addMutation(block, fn, blocks_4.MutatorTypes.DefaultInstanceMutator);
            }
            else if (fn.attributes._expandedDef && fn.attributes.expandableArgumentMode !== "disabled") {
                const shouldToggle = fn.attributes.expandableArgumentMode === "toggle";
                blocks_4.initExpandableBlock(info, block, fn.attributes._expandedDef, comp, shouldToggle, () => buildBlockFromDef(fn.attributes._expandedDef, true));
            }
            else if (comp.handlerArgs.length) {
                /**
                 * We support four modes for handler parameters: variable dropdowns,
                 * expandable variable dropdowns with +/- buttons (used for chat commands),
                 * draggable variable blocks, and draggable reporter blocks.
                 */
                hasHandler = true;
                if (fn.attributes.optionalVariableArgs) {
                    blocks_4.initVariableArgsBlock(block, comp.handlerArgs);
                }
                else if (fn.attributes.draggableParameters) {
                    comp.handlerArgs.filter(a => !a.inBlockDef).forEach(arg => {
                        const i = block.appendValueInput("HANDLER_DRAG_PARAM_" + arg.name);
                        if (fn.attributes.draggableParameters == "reporter") {
                            i.setCheck(getBlocklyCheckForType(arg.type, info));
                        }
                        else {
                            i.setCheck("Variable");
                        }
                    });
                }
                else {
                    let i = block.appendDummyInput();
                    comp.handlerArgs.filter(a => !a.inBlockDef).forEach(arg => {
                        i.appendField(new Blockly.FieldVariable(arg.name), "HANDLER_" + arg.name);
                    });
                }
            }
            // Add mutation to save and restore custom field settings
            blocks_4.appendMutation(block, {
                mutationToDom: (el) => {
                    block.inputList.forEach(input => {
                        input.fieldRow.forEach((fieldRow) => {
                            if (fieldRow.isFieldCustom_ && fieldRow.saveOptions) {
                                const getOptions = fieldRow.saveOptions();
                                if (getOptions) {
                                    el.setAttribute(`customfield`, JSON.stringify(getOptions));
                                }
                            }
                        });
                    });
                    return el;
                },
                domToMutation: (saved) => {
                    block.inputList.forEach(input => {
                        input.fieldRow.forEach((fieldRow) => {
                            if (fieldRow.isFieldCustom_ && fieldRow.restoreOptions) {
                                const options = JSON.parse(saved.getAttribute(`customfield`));
                                if (options) {
                                    fieldRow.restoreOptions(options);
                                }
                            }
                        });
                    });
                }
            });
            if (fn.attributes.imageLiteral) {
                const columns = (fn.attributes.imageLiteralColumns || 5) * fn.attributes.imageLiteral;
                const rows = fn.attributes.imageLiteralRows || 5;
                const scale = fn.attributes.imageLiteralScale;
                let ri = block.appendDummyInput();
                ri.appendField(new pxtblockly.FieldMatrix("", { columns, rows, scale }), "LEDS");
            }
            if (fn.attributes.inlineInputMode === "external") {
                block.setInputsInline(false);
            }
            else if (fn.attributes.inlineInputMode === "inline") {
                block.setInputsInline(true);
            }
            else {
                block.setInputsInline(!fn.parameters || (fn.parameters.length < 4 && !fn.attributes.imageLiteral));
            }
            const body = (_a = fn.parameters) === null || _a === void 0 ? void 0 : _a.find(pr => pxtc.parameterTypeIsArrowFunction(pr));
            if (body || hasHandler) {
                block.appendStatementInput("HANDLER")
                    .setCheck(null);
                block.setInputsInline(true);
            }
            setOutputCheck(block, fn.retType, info);
            // hook up/down if return value is void
            const hasHandlers = hasArrowFunction(fn);
            block.setPreviousStatement(!(hasHandlers && !fn.attributes.handlerStatement) && fn.retType == "void");
            block.setNextStatement(!(hasHandlers && !fn.attributes.handlerStatement) && fn.retType == "void");
            block.setTooltip(/^__/.test(fn.namespace) ? "" : fn.attributes.jsDoc);
            function buildBlockFromDef(def, expanded = false) {
                let anonIndex = 0;
                let firstParam = !expanded && !!comp.thisParameter;
                const inputs = splitInputs(def);
                const imgConv = new pxt.ImageConverter();
                if (fn.attributes.shim === "ENUM_GET" || fn.attributes.shim === "KIND_GET") {
                    if (comp.parameters.length > 1 || comp.thisParameter) {
                        console.warn(`Enum blocks may only have 1 parameter but ${fn.attributes.blockId} has ${comp.parameters.length}`);
                        return;
                    }
                }
                const hasInput = (name) => { var _a; return (_a = block.inputList) === null || _a === void 0 ? void 0 : _a.some(i => i.name === name); };
                inputs.forEach(inputParts => {
                    const fields = [];
                    let inputName;
                    let inputCheck;
                    let hasParameter = false;
                    inputParts.forEach(part => {
                        if (part.kind !== "param") {
                            const f = newLabel(part);
                            if (f) {
                                fields.push({ field: f });
                            }
                        }
                        else if (fn.attributes.shim === "ENUM_GET") {
                            pxt.U.assert(!!fn.attributes.enumName, "Trying to create an ENUM_GET block without a valid enum name");
                            fields.push({
                                name: "MEMBER",
                                field: new pxtblockly.FieldUserEnum(info.enumsByName[fn.attributes.enumName])
                            });
                            return;
                        }
                        else if (fn.attributes.shim === "KIND_GET") {
                            fields.push({
                                name: "MEMBER",
                                field: new pxtblockly.FieldKind(info.kindsByName[fn.attributes.kindNamespace || fn.attributes.blockNamespace || fn.namespace])
                            });
                            return;
                        }
                        else {
                            // find argument
                            let pr = getParameterFromDef(part, comp, firstParam);
                            firstParam = false;
                            if (!pr) {
                                console.error("block " + fn.attributes.blockId + ": unknown parameter " + part.name + (part.ref ? ` (${part.ref})` : ""));
                                return;
                            }
                            if (isHandlerArg(pr)) {
                                inputName = "HANDLER_DRAG_PARAM_" + pr.name;
                                inputCheck = fn.attributes.draggableParameters === "reporter" ? getBlocklyCheckForType(pr.type, info) : "Variable";
                                return;
                            }
                            let typeInfo = pxt.U.lookup(info.apis.byQName, pr.type);
                            hasParameter = true;
                            const defName = pr.definitionName;
                            const actName = pr.actualName;
                            let isEnum = typeInfo && typeInfo.kind == 6 /* Enum */;
                            let isFixed = typeInfo && !!typeInfo.attributes.fixedInstances && !pr.shadowBlockId;
                            let isConstantShim = !!fn.attributes.constantShim;
                            let isCombined = pr.type == "@combined@";
                            let customField = pr.fieldEditor;
                            let fieldLabel = defName.charAt(0).toUpperCase() + defName.slice(1);
                            let fieldType = pr.type;
                            if (isEnum || isFixed || isConstantShim || isCombined) {
                                let syms;
                                if (isEnum) {
                                    syms = getEnumDropdownValues(info.apis, pr.type);
                                }
                                else if (isFixed) {
                                    syms = getFixedInstanceDropdownValues(info.apis, typeInfo.qName);
                                }
                                else if (isCombined) {
                                    syms = fn.combinedProperties.map(p => pxt.U.lookup(info.apis.byQName, p));
                                }
                                else {
                                    syms = getConstantDropdownValues(info.apis, fn.qName);
                                }
                                if (syms.length == 0) {
                                    console.error(`no instances of ${typeInfo.qName} found`);
                                }
                                const dd = syms.map(v => {
                                    let k = v.attributes.block || v.attributes.blockId || v.name;
                                    let comb = v.attributes.blockCombine;
                                    if (v.attributes.jresURL && !v.attributes.iconURL && pxt.U.startsWith(v.attributes.jresURL, "data:image/x-mkcd-f")) {
                                        v.attributes.iconURL = imgConv.convert(v.attributes.jresURL);
                                    }
                                    if (!!comb)
                                        k = k.replace(/@set/, "");
                                    return [
                                        v.attributes.iconURL || v.attributes.blockImage ? {
                                            src: v.attributes.iconURL || pxt.Util.pathJoin(pxt.webConfig.commitCdnUrl, `blocks/${v.namespace.toLowerCase()}/${v.name.toLowerCase()}.png`),
                                            alt: k,
                                            width: 36,
                                            height: 36,
                                            value: v.name
                                        } : k,
                                        v.namespace + "." + v.name
                                    ];
                                });
                                // if a value is provided, move it first
                                if (pr.defaultValue) {
                                    let shadowValueIndex = -1;
                                    dd.some((v, i) => {
                                        if (v[1] === pr.defaultValue) {
                                            shadowValueIndex = i;
                                            return true;
                                        }
                                        return false;
                                    });
                                    if (shadowValueIndex > -1) {
                                        const shadowValue = dd.splice(shadowValueIndex, 1)[0];
                                        dd.unshift(shadowValue);
                                    }
                                }
                                if (customField) {
                                    let defl = fn.attributes.paramDefl[actName] || "";
                                    const options = {
                                        data: dd,
                                        colour: color,
                                        label: fieldLabel,
                                        type: fieldType,
                                        blocksInfo: info
                                    };
                                    pxt.Util.jsonMergeFrom(options, fn.attributes.paramFieldEditorOptions && fn.attributes.paramFieldEditorOptions[actName] || {});
                                    fields.push(namedField(blocks_4.createFieldEditor(customField, defl, options), defName));
                                }
                                else
                                    fields.push(namedField(new Blockly.FieldDropdown(dd), defName));
                            }
                            else if (customField) {
                                const defl = fn.attributes.paramDefl[pr.actualName] || "";
                                const options = {
                                    colour: color,
                                    label: fieldLabel,
                                    type: fieldType,
                                    blocksInfo: info
                                };
                                pxt.Util.jsonMergeFrom(options, fn.attributes.paramFieldEditorOptions && fn.attributes.paramFieldEditorOptions[pr.actualName] || {});
                                fields.push(namedField(blocks_4.createFieldEditor(customField, defl, options), pr.definitionName));
                            }
                            else {
                                inputName = defName;
                                if (instance && part.name === "this") {
                                    inputCheck = pr.type;
                                }
                                else if (pr.type == "number" && pr.shadowBlockId && pr.shadowBlockId == "value") {
                                    inputName = undefined;
                                    fields.push(namedField(new Blockly.FieldNumber("0"), defName));
                                }
                                else if (pr.type == "string" && pr.shadowOptions && pr.shadowOptions.toString) {
                                    inputCheck = null;
                                }
                                else {
                                    inputCheck = getBlocklyCheckForType(pr.type, info);
                                }
                            }
                        }
                    });
                    let input;
                    if (inputName) {
                        // Don't add duplicate inputs
                        if (hasInput(inputName))
                            return;
                        input = block.appendValueInput(inputName);
                        input.setAlign(Blockly.ALIGN_LEFT);
                    }
                    else if (expanded) {
                        const prefix = hasParameter ? blocks_4.optionalInputWithFieldPrefix : blocks_4.optionalDummyInputPrefix;
                        inputName = prefix + (anonIndex++);
                        // Don't add duplicate inputs
                        if (hasInput(inputName))
                            return;
                        input = block.appendDummyInput(inputName);
                    }
                    else {
                        input = block.appendDummyInput();
                    }
                    if (inputCheck) {
                        input.setCheck(inputCheck);
                    }
                    fields.forEach(f => input.appendField(f.field, f.name));
                });
                imgConv.logTime();
            }
        }
        function getParameterFromDef(part, comp, isThis = false) {
            if (part.ref) {
                const result = (part.name === "this") ? comp.thisParameter : comp.actualNameToParam[part.name];
                if (!result) {
                    let ha;
                    comp.handlerArgs.forEach(arg => {
                        if (arg.name === part.name)
                            ha = arg;
                    });
                    if (ha)
                        return ha;
                }
                return result;
            }
            else {
                return isThis ? comp.thisParameter : comp.definitionNameToParam[part.name];
            }
        }
        function isHandlerArg(arg) {
            return !arg.definitionName;
        }
        function hasArrowFunction(fn) {
            var _a;
            return !!((_a = fn.parameters) === null || _a === void 0 ? void 0 : _a.some(pr => pxtc.parameterTypeIsArrowFunction(pr)));
        }
        blocks_4.hasArrowFunction = hasArrowFunction;
        function cleanBlocks() {
            pxt.debug('removing all custom blocks');
            for (const b in cachedBlocks)
                removeBlock(cachedBlocks[b].fn);
        }
        blocks_4.cleanBlocks = cleanBlocks;
        /**
         * Used by pxtrunner to initialize blocks in the docs
         */
        function initializeAndInject(blockInfo) {
            init();
            injectBlocks(blockInfo);
        }
        blocks_4.initializeAndInject = initializeAndInject;
        /**
         * Used by main app to initialize blockly blocks.
         * Blocks are injected separately by called injectBlocks
         */
        function initialize(blockInfo) {
            init();
            initJresIcons(blockInfo);
        }
        blocks_4.initialize = initialize;
        let blocklyInitialized = false;
        function init() {
            if (blocklyInitialized)
                return;
            blocklyInitialized = true;
            goog.provide('Blockly.Blocks.device');
            goog.require('Blockly.Blocks');
            Blockly.FieldCheckbox.CHECK_CHAR = '■';
            Blockly.Constants.ADD_START_HATS = !!pxt.appTarget.appTheme.blockHats;
            blocks_4.initFieldEditors();
            initContextMenu();
            initOnStart();
            initMath();
            initVariables();
            initFunctions();
            initLists();
            initLoops();
            initLogic();
            initText();
            initDrag();
            initDebugger();
            initComments();
            initTooltip();
            // PXT is in charge of disabling, don't record undo for disabled events
            Blockly.Block.prototype.setEnabled = function (enabled) {
                if (this.disabled == enabled) {
                    let oldRecordUndo = Blockly.Events.recordUndo;
                    Blockly.Events.recordUndo = false;
                    Blockly.Events.fire(new Blockly.Events.BlockChange(this, 'disabled', null, this.disabled, !enabled));
                    Blockly.Events.recordUndo = oldRecordUndo;
                    this.disabled = !enabled;
                }
            };
        }
        /**
         * Converts a TypeScript type into an array of type checks for Blockly inputs/outputs. Use
         * with block.setOutput() and input.setCheck().
         *
         * @returns An array of checks if the type is valid, undefined if there are no valid checks
         *      (e.g. type is void), and null if all checks should be accepted (e.g. type is generic)
         */
        function getBlocklyCheckForType(type, info) {
            const types = type.split(/\s*\|\s*/);
            const output = [];
            for (const subtype of types) {
                switch (subtype) {
                    // Blockly capitalizes primitive types for its builtin math/string/logic blocks
                    case "number":
                        output.push("Number");
                        break;
                    case "string":
                        output.push("String");
                        break;
                    case "boolean":
                        output.push("Boolean");
                        break;
                    case "T":
                    // The type is generic, so accept any checks. This is mostly used with functions that
                    // get values from arrays. This could be improved if we ever add proper type
                    // inference for generic types
                    case "any":
                        return null;
                    case "void":
                        return undefined;
                    default:
                        // We add "Array" to the front for array types so that they can be connected
                        // to the blocks that accept any array (e.g. length, push, pop, etc)
                        if (isArrayType(subtype)) {
                            if (types.length > 1) {
                                // type inference will potentially break non-trivial arrays in intersections
                                // until we have better type handling in blocks,
                                // so escape and allow any block to be dropped in.
                                return null;
                            }
                            else {
                                output.push("Array");
                            }
                        }
                        // Blockly has no concept of inheritance, so we need to add all
                        // super classes to the check array
                        const si_r = info.apis.byQName[subtype];
                        if (si_r && si_r.extendsTypes && 0 < si_r.extendsTypes.length) {
                            output.push(...si_r.extendsTypes);
                        }
                        else {
                            output.push(subtype);
                        }
                }
            }
            return output;
        }
        function setOutputCheck(block, retType, info) {
            const check = getBlocklyCheckForType(retType, info);
            if (check || check === null) {
                block.setOutput(true, check);
            }
        }
        function setBuiltinHelpInfo(block, id) {
            const info = pxt.blocks.getBlockDefinition(id);
            setHelpResources(block, id, info.name, info.tooltip, info.url, pxt.toolbox.getNamespaceColor(info.category));
        }
        function installBuiltinHelpInfo(id) {
            const info = pxt.blocks.getBlockDefinition(id);
            installHelpResources(id, info.name, info.tooltip, info.url, pxt.toolbox.getNamespaceColor(info.category));
        }
        function setHelpResources(block, id, name, tooltip, url, colour, colourSecondary, colourTertiary, undeletable) {
            if (tooltip && (typeof tooltip === "string" || typeof tooltip === "function"))
                block.setTooltip(tooltip);
            if (url)
                block.setHelpUrl(url);
            if (colour)
                block.setColour(colour, colourSecondary, colourTertiary);
            if (undeletable)
                block.setDeletable(false);
            let tb = document.getElementById('blocklyToolboxDefinition');
            let xml = tb ? blocks_4.getFirstChildWithAttr(tb, "block", "type", id) : undefined;
            block.codeCard = {
                header: name,
                name: name,
                software: 1,
                description: goog.isFunction(tooltip) ? tooltip(block) : tooltip,
                blocksXml: xml ? (`<xml xmlns="http://www.w3.org/1999/xhtml">` + (cleanOuterHTML(xml) || `<block type="${id}"></block>`) + "</xml>") : undefined,
                url: url
            };
            if (pxt.Util.isTranslationMode()
                && pxt.blocks.promptTranslateBlock) {
                block.customContextMenu = (options) => {
                    const blockd = pxt.blocks.getBlockDefinition(block.type);
                    if (blockd && blockd.translationIds) {
                        options.push({
                            enabled: true,
                            text: lf("Translate this block"),
                            callback: function () {
                                pxt.blocks.promptTranslateBlock(id, blockd.translationIds);
                            }
                        });
                    }
                };
            }
        }
        function installHelpResources(id, name, tooltip, url, colour, colourSecondary, colourTertiary) {
            let block = Blockly.Blocks[id];
            let old = block.init;
            if (!old)
                return;
            block.init = function () {
                old.call(this);
                let block = this;
                setHelpResources(this, id, name, tooltip, url, colour, colourSecondary, colourTertiary);
            };
        }
        blocks_4.installHelpResources = installHelpResources;
        function initLists() {
            const msg = Blockly.Msg;
            // lists_create_with
            const listsCreateWithId = "lists_create_with";
            const listsCreateWithDef = pxt.blocks.getBlockDefinition(listsCreateWithId);
            msg.LISTS_CREATE_EMPTY_TITLE = listsCreateWithDef.block["LISTS_CREATE_EMPTY_TITLE"];
            msg.LISTS_CREATE_WITH_INPUT_WITH = listsCreateWithDef.block["LISTS_CREATE_WITH_INPUT_WITH"];
            msg.LISTS_CREATE_WITH_CONTAINER_TITLE_ADD = listsCreateWithDef.block["LISTS_CREATE_WITH_CONTAINER_TITLE_ADD"];
            msg.LISTS_CREATE_WITH_ITEM_TITLE = listsCreateWithDef.block["LISTS_CREATE_WITH_ITEM_TITLE"];
            installBuiltinHelpInfo(listsCreateWithId);
            // lists_length
            const listsLengthId = "lists_length";
            const listsLengthDef = pxt.blocks.getBlockDefinition(listsLengthId);
            msg.LISTS_LENGTH_TITLE = listsLengthDef.block["LISTS_LENGTH_TITLE"];
            // We have to override this block definition because the builtin block
            // allows both Strings and Arrays in its input check and that confuses
            // our Blockly compiler
            let block = Blockly.Blocks[listsLengthId];
            block.init = function () {
                this.jsonInit({
                    "message0": msg.LISTS_LENGTH_TITLE,
                    "args0": [
                        {
                            "type": "input_value",
                            "name": "VALUE",
                            "check": ['Array']
                        }
                    ],
                    "output": 'Number',
                    "outputShape": Blockly.OUTPUT_SHAPE_ROUND
                });
            };
            installBuiltinHelpInfo(listsLengthId);
        }
        function initLoops() {
            const msg = Blockly.Msg;
            // controls_repeat_ext
            const controlsRepeatExtId = "controls_repeat_ext";
            const controlsRepeatExtDef = pxt.blocks.getBlockDefinition(controlsRepeatExtId);
            msg.CONTROLS_REPEAT_TITLE = controlsRepeatExtDef.block["CONTROLS_REPEAT_TITLE"];
            msg.CONTROLS_REPEAT_INPUT_DO = controlsRepeatExtDef.block["CONTROLS_REPEAT_INPUT_DO"];
            installBuiltinHelpInfo(controlsRepeatExtId);
            // device_while
            const deviceWhileId = "device_while";
            const deviceWhileDef = pxt.blocks.getBlockDefinition(deviceWhileId);
            Blockly.Blocks[deviceWhileId] = {
                init: function () {
                    this.jsonInit({
                        "message0": deviceWhileDef.block["message0"],
                        "args0": [
                            {
                                "type": "input_value",
                                "name": "COND",
                                "check": "Boolean"
                            }
                        ],
                        "previousStatement": null,
                        "nextStatement": null,
                        "colour": pxt.toolbox.getNamespaceColor('loops')
                    });
                    this.appendStatementInput("DO")
                        .appendField(deviceWhileDef.block["appendField"]);
                    setBuiltinHelpInfo(this, deviceWhileId);
                }
            };
            // pxt_controls_for
            const pxtControlsForId = "pxt_controls_for";
            const pxtControlsForDef = pxt.blocks.getBlockDefinition(pxtControlsForId);
            Blockly.Blocks[pxtControlsForId] = {
                /**
                 * Block for 'for' loop.
                 * @this Blockly.Block
                 */
                init: function () {
                    this.jsonInit({
                        "message0": pxtControlsForDef.block["message0"],
                        "args0": [
                            {
                                "type": "input_value",
                                "name": "VAR",
                                "variable": pxtControlsForDef.block["variable"],
                                "check": "Variable"
                            },
                            {
                                "type": "input_value",
                                "name": "TO",
                                "check": "Number"
                            }
                        ],
                        "previousStatement": null,
                        "nextStatement": null,
                        "colour": pxt.toolbox.getNamespaceColor('loops'),
                        "inputsInline": true
                    });
                    this.appendStatementInput('DO')
                        .appendField(pxtControlsForDef.block["appendField"]);
                    let thisBlock = this;
                    setHelpResources(this, pxtControlsForId, pxtControlsForDef.name, function () {
                        return pxt.U.rlf(pxtControlsForDef.tooltip, thisBlock.getInputTargetBlock('VAR') ? thisBlock.getInputTargetBlock('VAR').getField('VAR').getText() : '');
                    }, pxtControlsForDef.url, String(pxt.toolbox.getNamespaceColor('loops')));
                },
                /**
                 * Return all variables referenced by this block.
                 * @return {!Array.<string>} List of variable names.
                 * @this Blockly.Block
                 */
                getVars: function () {
                    return [this.getField('VAR').getText()];
                },
                /**
                 * Notification that a variable is renaming.
                 * If the name matches one of this block's variables, rename it.
                 * @param {string} oldName Previous name of variable.
                 * @param {string} newName Renamed variable.
                 * @this Blockly.Block
                 */
                renameVar: function (oldName, newName) {
                    const varField = this.getField('VAR');
                    if (Blockly.Names.equals(oldName, varField.getText())) {
                        varField.setValue(newName);
                    }
                }
            };
            // controls_simple_for
            const controlsSimpleForId = "controls_simple_for";
            const controlsSimpleForDef = pxt.blocks.getBlockDefinition(controlsSimpleForId);
            Blockly.Blocks[controlsSimpleForId] = {
                /**
                 * Block for 'for' loop.
                 * @this Blockly.Block
                 */
                init: function () {
                    this.jsonInit({
                        "message0": controlsSimpleForDef.block["message0"],
                        "args0": [
                            {
                                "type": "field_variable",
                                "name": "VAR",
                                "variable": controlsSimpleForDef.block["variable"]
                                // Please note that most multilingual characters
                                // cannot be used as variable name at this point.
                                // Translate or decide the default variable name
                                // with care.
                            },
                            {
                                "type": "input_value",
                                "name": "TO",
                                "check": "Number"
                            }
                        ],
                        "previousStatement": null,
                        "nextStatement": null,
                        "colour": pxt.toolbox.getNamespaceColor('loops'),
                        "inputsInline": true
                    });
                    this.appendStatementInput('DO')
                        .appendField(controlsSimpleForDef.block["appendField"]);
                    let thisBlock = this;
                    setHelpResources(this, controlsSimpleForId, controlsSimpleForDef.name, function () {
                        return pxt.U.rlf(controlsSimpleForDef.tooltip, thisBlock.getField('VAR').getText());
                    }, controlsSimpleForDef.url, String(pxt.toolbox.getNamespaceColor('loops')));
                },
                /**
                 * Return all variables referenced by this block.
                 * @return {!Array.<string>} List of variable names.
                 * @this Blockly.Block
                 */
                getVars: function () {
                    return [this.getField('VAR').getText()];
                },
                /**
                 * Notification that a variable is renaming.
                 * If the name matches one of this block's variables, rename it.
                 * @param {string} oldName Previous name of variable.
                 * @param {string} newName Renamed variable.
                 * @this Blockly.Block
                 */
                renameVar: function (oldName, newName) {
                    const varField = this.getField('VAR');
                    if (Blockly.Names.equals(oldName, varField.getText())) {
                        varField.setValue(newName);
                    }
                },
                /**
                 * Add menu option to create getter block for loop variable.
                 * @param {!Array} options List of menu options to add to.
                 * @this Blockly.Block
                 */
                customContextMenu: function (options) {
                    if (!this.isCollapsed() && !this.inDebugWorkspace()) {
                        let option = { enabled: true };
                        let name = this.getField('VAR').getText();
                        option.text = lf("Create 'get {0}'", name);
                        let xmlField = goog.dom.createDom('field', null, name);
                        xmlField.setAttribute('name', 'VAR');
                        let xmlBlock = goog.dom.createDom('block', null, xmlField);
                        xmlBlock.setAttribute('type', 'variables_get');
                        option.callback = Blockly.ContextMenu.callbackFactory(this, xmlBlock);
                        options.push(option);
                    }
                }
            };
            // break statement
            const breakBlockDef = pxt.blocks.getBlockDefinition(ts.pxtc.TS_BREAK_TYPE);
            Blockly.Blocks[pxtc.TS_BREAK_TYPE] = {
                init: function () {
                    const color = pxt.toolbox.getNamespaceColor('loops');
                    this.jsonInit({
                        "message0": breakBlockDef.block["message0"],
                        "inputsInline": true,
                        "previousStatement": null,
                        "nextStatement": null,
                        "colour": color
                    });
                    setHelpResources(this, ts.pxtc.TS_BREAK_TYPE, breakBlockDef.name, breakBlockDef.tooltip, breakBlockDef.url, color, undefined /*colourSecondary*/, undefined /*colourTertiary*/, false /*undeletable*/);
                }
            };
            // continue statement
            const continueBlockDef = pxt.blocks.getBlockDefinition(ts.pxtc.TS_CONTINUE_TYPE);
            Blockly.Blocks[pxtc.TS_CONTINUE_TYPE] = {
                init: function () {
                    const color = pxt.toolbox.getNamespaceColor('loops');
                    this.jsonInit({
                        "message0": continueBlockDef.block["message0"],
                        "inputsInline": true,
                        "previousStatement": null,
                        "nextStatement": null,
                        "colour": color
                    });
                    setHelpResources(this, ts.pxtc.TS_CONTINUE_TYPE, continueBlockDef.name, continueBlockDef.tooltip, continueBlockDef.url, color, undefined /*colourSecondary*/, undefined /*colourTertiary*/, false /*undeletable*/);
                }
            };
            const collapsedColor = "#cccccc";
            Blockly.Blocks[pxtc.COLLAPSED_BLOCK] = {
                init: function () {
                    this.jsonInit({
                        "message0": "...",
                        "inputsInline": true,
                        "previousStatement": null,
                        "nextStatement": null,
                        "colour": collapsedColor
                    });
                    setHelpResources(this, ts.pxtc.COLLAPSED_BLOCK, "...", lf("a few blocks"), undefined, collapsedColor, undefined /*colourSecondary*/, undefined /*colourTertiary*/, false /*undeletable*/);
                }
            };
        }
        blocks_4.onShowContextMenu = undefined;
        /**
         * The following patch to blockly is to add the Trash icon on top of the toolbox,
         * the trash icon should only show when a user drags a block that is already in the workspace.
         */
        function initDrag() {
            const calculateDistance = (elemBounds, mouseX) => {
                return Math.abs(mouseX - (elemBounds.left + (elemBounds.width / 2)));
            };
            /**
             * Execute a step of block dragging, based on the given event.  Update the
             * display accordingly.
             * @param {!Event} e The most recent move event.
             * @param {!goog.math.Coordinate} currentDragDeltaXY How far the pointer has
             *     moved from the position at the start of the drag, in pixel units.
             * @package
             */
            const blockDrag = Blockly.BlockDragger.prototype.drag;
            Blockly.BlockDragger.prototype.drag = function (e, currentDragDeltaXY) {
                const blocklyToolboxDiv = document.getElementsByClassName('blocklyToolboxDiv')[0];
                const blocklyTreeRoot = document.getElementsByClassName('blocklyTreeRoot')[0]
                    || document.getElementsByClassName('blocklyFlyout')[0];
                const trashIcon = document.getElementById("blocklyTrashIcon");
                if (blocklyTreeRoot && trashIcon) {
                    const distance = calculateDistance(blocklyTreeRoot.getBoundingClientRect(), e.clientX);
                    if (distance < 200) {
                        const opacity = distance / 200;
                        trashIcon.style.opacity = `${1 - opacity}`;
                        trashIcon.style.display = 'block';
                        if (blocklyToolboxDiv) {
                            blocklyTreeRoot.style.opacity = `${opacity}`;
                            if (distance < 50) {
                                pxt.BrowserUtils.addClass(blocklyToolboxDiv, 'blocklyToolboxDeleting');
                            }
                        }
                    }
                    else {
                        trashIcon.style.display = 'none';
                        blocklyTreeRoot.style.opacity = '1';
                        if (blocklyToolboxDiv)
                            pxt.BrowserUtils.removeClass(blocklyToolboxDiv, 'blocklyToolboxDeleting');
                    }
                }
                return blockDrag.call(this, e, currentDragDeltaXY);
            };
            /**
             * Finish dragging the workspace and put everything back where it belongs.
             * @param {!goog.math.Coordinate} currentDragDeltaXY How far the pointer has
             *     moved from the position at the start of the drag, in pixel coordinates.
             * @package
             */
            const blockEndDrag = Blockly.BlockDragger.prototype.endDrag;
            Blockly.BlockDragger.prototype.endDrag = function (e, currentDragDeltaXY) {
                blockEndDrag.call(this, e, currentDragDeltaXY);
                const blocklyToolboxDiv = document.getElementsByClassName('blocklyToolboxDiv')[0];
                const blocklyTreeRoot = document.getElementsByClassName('blocklyTreeRoot')[0]
                    || document.getElementsByClassName('blocklyFlyout')[0];
                const trashIcon = document.getElementById("blocklyTrashIcon");
                if (trashIcon && blocklyTreeRoot) {
                    trashIcon.style.display = 'none';
                    blocklyTreeRoot.style.opacity = '1';
                    if (blocklyToolboxDiv)
                        pxt.BrowserUtils.removeClass(blocklyToolboxDiv, 'blocklyToolboxDeleting');
                }
            };
        }
        function initContextMenu() {
            // Translate the context menu for blocks.
            const msg = Blockly.Msg;
            msg.DUPLICATE_BLOCK = lf("{id:block}Duplicate");
            msg.DUPLICATE_COMMENT = lf("Duplicate Comment");
            msg.REMOVE_COMMENT = lf("Remove Comment");
            msg.ADD_COMMENT = lf("Add Comment");
            msg.EXTERNAL_INPUTS = lf("External Inputs");
            msg.INLINE_INPUTS = lf("Inline Inputs");
            msg.EXPAND_BLOCK = lf("Expand Block");
            msg.COLLAPSE_BLOCK = lf("Collapse Block");
            msg.ENABLE_BLOCK = lf("Enable Block");
            msg.DISABLE_BLOCK = lf("Disable Block");
            msg.DELETE_BLOCK = lf("Delete Block");
            msg.DELETE_X_BLOCKS = lf("Delete Blocks");
            msg.DELETE_ALL_BLOCKS = lf("Delete All Blocks");
            msg.HELP = lf("Help");
            // inject hook to handle openings docs
            Blockly.BlockSvg.prototype.showHelp = function () {
                const url = goog.isFunction(this.helpUrl) ? this.helpUrl() : this.helpUrl;
                if (url)
                    (pxt.blocks.openHelpUrl || window.open)(url);
            };
            // Use Blockly hook to customize context menu
            Blockly.WorkspaceSvg.prototype.configureContextMenu = function (options, e) {
                if (this.options.readOnly || this.isFlyout) {
                    return;
                }
                // Clear default Blockly options
                options.length = 0;
                let topBlocks = this.getTopBlocks(true);
                let eventGroup = Blockly.utils.genUid();
                let topComments = this.getTopComments();
                let ws = this;
                const editable = !(this.options.debugMode || this.options.readOnly);
                // Option to add a workspace comment.
                if (this.options.comments && !pxt.BrowserUtils.isIE()) {
                    const commentOption = Blockly.ContextMenu.workspaceCommentOption(ws, e);
                    commentOption.enabled = commentOption.enabled && editable;
                    options.push(commentOption);
                }
                // Option to delete all blocks.
                // Count the number of blocks that are deletable.
                let deleteList = Blockly.WorkspaceSvg.buildDeleteList_(topBlocks);
                let deleteCount = 0;
                for (let i = 0; i < deleteList.length; i++) {
                    if (!deleteList[i].isShadow()) {
                        deleteCount++;
                    }
                }
                // Add a little animation to deleting.
                const DELAY = 10;
                function deleteNext() {
                    Blockly.Events.setGroup(eventGroup);
                    let block = deleteList.shift();
                    if (block) {
                        if (block.workspace) {
                            block.dispose(false, true);
                            setTimeout(deleteNext, DELAY);
                        }
                        else {
                            deleteNext();
                        }
                    }
                    Blockly.Events.setGroup(false);
                }
                const deleteOption = {
                    text: deleteCount == 1 ? msg.DELETE_BLOCK : msg.DELETE_ALL_BLOCKS,
                    enabled: deleteCount > 0 && editable,
                    callback: () => {
                        pxt.tickEvent("blocks.context.delete", undefined, { interactiveConsent: true });
                        if (deleteCount < 2) {
                            deleteNext();
                        }
                        else {
                            Blockly.confirm(lf("Delete all {0} blocks?", deleteCount), (ok) => {
                                if (ok) {
                                    deleteNext();
                                }
                            });
                        }
                    }
                };
                options.push(deleteOption);
                const formatCodeOption = {
                    text: lf("Format Code"),
                    enabled: editable,
                    callback: () => {
                        pxt.tickEvent("blocks.context.format", undefined, { interactiveConsent: true });
                        pxt.blocks.layout.flow(this, { useViewWidth: true });
                    }
                };
                options.push(formatCodeOption);
                if (pxt.appTarget.appTheme.blocksCollapsing) {
                    // Option to collapse all top-level (enabled) blocks
                    const collapseAllOption = {
                        text: lf("Collapse Blocks"),
                        enabled: topBlocks.length && topBlocks.find((b) => b.isEnabled() && !b.isCollapsed()) && editable,
                        callback: () => {
                            pxt.tickEvent("blocks.context.collapse", undefined, { interactiveConsent: true });
                            pxt.blocks.layout.setCollapsedAll(this, true);
                        }
                    };
                    options.push(collapseAllOption);
                    // Option to expand all collapsed blocks
                    const expandAllOption = {
                        text: lf("Expand Blocks"),
                        enabled: topBlocks.length && topBlocks.find((b) => b.isEnabled() && b.isCollapsed()) && editable,
                        callback: () => {
                            pxt.tickEvent("blocks.context.expand", undefined, { interactiveConsent: true });
                            pxt.blocks.layout.setCollapsedAll(this, false);
                        }
                    };
                    options.push(expandAllOption);
                }
                if (pxt.blocks.layout.screenshotEnabled()) {
                    const screenshotOption = {
                        text: lf("Snapshot"),
                        enabled: topBlocks.length > 0 || topComments.length > 0,
                        callback: () => {
                            var _a;
                            pxt.tickEvent("blocks.context.screenshot", undefined, { interactiveConsent: true });
                            pxt.blocks.layout.screenshotAsync(this, null, (_a = pxt.appTarget.appTheme) === null || _a === void 0 ? void 0 : _a.embedBlocksInSnapshot)
                                .then((uri) => {
                                if (pxt.BrowserUtils.isSafari())
                                    uri = uri.replace(/^data:image\/[^;]/, 'data:application/octet-stream');
                                pxt.BrowserUtils.browserDownloadDataUri(uri, `${pxt.appTarget.nickname || pxt.appTarget.id}-${lf("screenshot")}.png`);
                            });
                        },
                    };
                    options.push(screenshotOption);
                }
                if (pxt.appTarget.appTheme.workspaceSearch) {
                    options.push({
                        text: lf("Find..."),
                        enabled: topBlocks.length > 0,
                        callback: () => {
                            var _a, _b;
                            pxt.tickEvent("blocks.context.workspacesearch", undefined, { interactiveConsent: true });
                            (_b = (_a = this.getComponentManager()) === null || _a === void 0 ? void 0 : _a.getComponent("workspaceSearch")) === null || _b === void 0 ? void 0 : _b.open();
                        }
                    });
                }
                // custom options...
                if (blocks_4.onShowContextMenu)
                    blocks_4.onShowContextMenu(this, options);
            };
            // Get rid of bumping behavior
            Blockly.Constants.Logic.LOGIC_COMPARE_ONCHANGE_MIXIN.onchange = function () { };
        }
        function initOnStart() {
            // on_start
            const onStartDef = pxt.blocks.getBlockDefinition(ts.pxtc.ON_START_TYPE);
            Blockly.Blocks[ts.pxtc.ON_START_TYPE] = {
                init: function () {
                    this.jsonInit({
                        "message0": onStartDef.block["message0"],
                        "args0": [
                            {
                                "type": "input_dummy"
                            },
                            {
                                "type": "input_statement",
                                "name": "HANDLER"
                            }
                        ],
                        "colour": (pxt.appTarget.runtime ? pxt.appTarget.runtime.onStartColor : '') || pxt.toolbox.getNamespaceColor('loops')
                    });
                    setHelpResources(this, ts.pxtc.ON_START_TYPE, onStartDef.name, onStartDef.tooltip, onStartDef.url, String((pxt.appTarget.runtime ? pxt.appTarget.runtime.onStartColor : '') || pxt.toolbox.getNamespaceColor('loops')), undefined, undefined, pxt.appTarget.runtime ? pxt.appTarget.runtime.onStartUnDeletable : false);
                }
            };
            Blockly.Blocks[pxtc.TS_STATEMENT_TYPE] = {
                init: function () {
                    let that = this;
                    that.setColour("#717171");
                    that.setPreviousStatement(true);
                    that.setNextStatement(true);
                    that.setInputsInline(false);
                    let pythonMode;
                    let lines;
                    that.domToMutation = (element) => {
                        const n = parseInt(element.getAttribute("numlines"));
                        that.declaredVariables = element.getAttribute("declaredvars");
                        lines = [];
                        for (let i = 0; i < n; i++) {
                            const line = element.getAttribute("line" + i);
                            lines.push(line);
                        }
                        // Add the initial TS inputs
                        that.setPythonEnabled(false);
                    };
                    that.mutationToDom = () => {
                        let mutation = document.createElement("mutation");
                        if (lines) {
                            lines.forEach((line, index) => mutation.setAttribute("line" + index, line));
                            mutation.setAttribute("numlines", lines.length.toString());
                        }
                        if (that.declaredVariables) {
                            mutation.setAttribute("declaredvars", this.declaredVariables);
                        }
                        return mutation;
                    };
                    // Consumed by the webapp
                    that.setPythonEnabled = (enabled) => {
                        if (pythonMode === enabled)
                            return;
                        // Remove all inputs
                        while (that.inputList.length) {
                            that.removeInput(that.inputList[0].name);
                        }
                        pythonMode = enabled;
                        if (enabled) {
                            // This field must be named LINE0 because otherwise Blockly will crash
                            // when trying to make an insertion marker. All insertion marker blocks
                            // need to have the same fields as the real block, and this field will
                            // always be created by domToMutation regardless of TS or Python mode
                            that.appendDummyInput().appendField(pxt.Util.lf("<python code>"), "LINE0");
                            that.setTooltip(lf("A Python statement that could not be converted to blocks"));
                        }
                        else {
                            lines.forEach((line, index) => {
                                that.appendDummyInput().appendField(line, "LINE" + index);
                            });
                            that.setTooltip(lf("A JavaScript statement that could not be converted to blocks"));
                        }
                    };
                    // Consumed by BlocklyCompiler
                    that.getLines = () => lines;
                    that.setEditable(false);
                    setHelpResources(this, pxtc.TS_STATEMENT_TYPE, lf("JavaScript statement"), lf("A JavaScript statement that could not be converted to blocks"), '/blocks/javascript-blocks', '#717171');
                }
            };
            Blockly.Blocks[pxtc.TS_OUTPUT_TYPE] = {
                init: function () {
                    let that = this;
                    that.setColour("#717171");
                    that.setPreviousStatement(false);
                    that.setNextStatement(false);
                    that.setOutput(true);
                    that.setEditable(false);
                    that.appendDummyInput().appendField(new pxtblockly.FieldTsExpression(""), "EXPRESSION");
                    that.setPythonEnabled = (enabled) => {
                        that.getField("EXPRESSION").setPythonEnabled(enabled);
                        if (enabled) {
                            that.setTooltip(lf("A Python expression that could not be converted to blocks"));
                        }
                        else {
                            that.setTooltip(lf("A JavaScript expression that could not be converted to blocks"));
                        }
                    };
                    setHelpResources(that, pxtc.TS_OUTPUT_TYPE, lf("JavaScript expression"), lf("A JavaScript expression that could not be converted to blocks"), '/blocks/javascript-blocks', "#717171");
                }
            };
            if (pxt.appTarget.runtime && pxt.appTarget.runtime.pauseUntilBlock) {
                const blockOptions = pxt.appTarget.runtime.pauseUntilBlock;
                const blockDef = pxt.blocks.getBlockDefinition(ts.pxtc.PAUSE_UNTIL_TYPE);
                Blockly.Blocks[pxtc.PAUSE_UNTIL_TYPE] = {
                    init: function () {
                        const color = blockOptions.color || pxt.toolbox.getNamespaceColor('loops');
                        this.jsonInit({
                            "message0": blockDef.block["message0"],
                            "args0": [
                                {
                                    "type": "input_value",
                                    "name": "PREDICATE",
                                    "check": "Boolean"
                                }
                            ],
                            "inputsInline": true,
                            "previousStatement": null,
                            "nextStatement": null,
                            "colour": color
                        });
                        setHelpResources(this, ts.pxtc.PAUSE_UNTIL_TYPE, blockDef.name, blockDef.tooltip, blockDef.url, color, undefined /*colourSecondary*/, undefined /*colourTertiary*/, false /*undeletable*/);
                    }
                };
            }
            // pxt_controls_for_of
            const pxtControlsForOfId = "pxt_controls_for_of";
            const pxtControlsForOfDef = pxt.blocks.getBlockDefinition(pxtControlsForOfId);
            Blockly.Blocks[pxtControlsForOfId] = {
                init: function () {
                    this.jsonInit({
                        "message0": pxtControlsForOfDef.block["message0"],
                        "args0": [
                            {
                                "type": "input_value",
                                "name": "VAR",
                                "variable": pxtControlsForOfDef.block["variable"],
                                "check": "Variable"
                            },
                            {
                                "type": "input_value",
                                "name": "LIST",
                                "check": ["Array", "String"]
                            }
                        ],
                        "previousStatement": null,
                        "nextStatement": null,
                        "colour": pxt.toolbox.blockColors['loops'],
                        "inputsInline": true
                    });
                    this.appendStatementInput('DO')
                        .appendField(pxtControlsForOfDef.block["appendField"]);
                    let thisBlock = this;
                    setHelpResources(this, pxtControlsForOfId, pxtControlsForOfDef.name, function () {
                        return pxt.U.rlf(pxtControlsForOfDef.tooltip, thisBlock.getInputTargetBlock('VAR') ? thisBlock.getInputTargetBlock('VAR').getField('VAR').getText() : '');
                    }, pxtControlsForOfDef.url, String(pxt.toolbox.getNamespaceColor('loops')));
                }
            };
            // controls_for_of
            const controlsForOfId = "controls_for_of";
            const controlsForOfDef = pxt.blocks.getBlockDefinition(controlsForOfId);
            Blockly.Blocks[controlsForOfId] = {
                init: function () {
                    this.jsonInit({
                        "message0": controlsForOfDef.block["message0"],
                        "args0": [
                            {
                                "type": "field_variable",
                                "name": "VAR",
                                "variable": controlsForOfDef.block["variable"]
                                // Please note that most multilingual characters
                                // cannot be used as variable name at this point.
                                // Translate or decide the default variable name
                                // with care.
                            },
                            {
                                "type": "input_value",
                                "name": "LIST",
                                "check": "Array"
                            }
                        ],
                        "previousStatement": null,
                        "nextStatement": null,
                        "colour": pxt.toolbox.blockColors['loops'],
                        "inputsInline": true
                    });
                    this.appendStatementInput('DO')
                        .appendField(controlsForOfDef.block["appendField"]);
                    let thisBlock = this;
                    setHelpResources(this, controlsForOfId, controlsForOfDef.name, function () {
                        return pxt.U.rlf(controlsForOfDef.tooltip, thisBlock.getField('VAR').getText());
                    }, controlsForOfDef.url, String(pxt.toolbox.getNamespaceColor('loops')));
                }
            };
            // lists_index_get
            const listsIndexGetId = "lists_index_get";
            const listsIndexGetDef = pxt.blocks.getBlockDefinition(listsIndexGetId);
            Blockly.Blocks["lists_index_get"] = {
                init: function () {
                    this.jsonInit({
                        "message0": listsIndexGetDef.block["message0"],
                        "args0": [
                            {
                                "type": "input_value",
                                "name": "LIST",
                                "check": "Array"
                            },
                            {
                                "type": "input_value",
                                "name": "INDEX",
                                "check": "Number"
                            }
                        ],
                        "colour": pxt.toolbox.blockColors['arrays'],
                        "outputShape": Blockly.OUTPUT_SHAPE_ROUND,
                        "inputsInline": true
                    });
                    this.setPreviousStatement(false);
                    this.setNextStatement(false);
                    this.setOutput(true);
                    setBuiltinHelpInfo(this, listsIndexGetId);
                }
            };
            // lists_index_set
            const listsIndexSetId = "lists_index_set";
            const listsIndexSetDef = pxt.blocks.getBlockDefinition(listsIndexSetId);
            Blockly.Blocks[listsIndexSetId] = {
                init: function () {
                    this.jsonInit({
                        "message0": listsIndexSetDef.block["message0"],
                        "args0": [
                            {
                                "type": "input_value",
                                "name": "LIST",
                                "check": "Array"
                            },
                            {
                                "type": "input_value",
                                "name": "INDEX",
                                "check": "Number"
                            },
                            {
                                "type": "input_value",
                                "name": "VALUE",
                                "check": null
                            }
                        ],
                        "previousStatement": null,
                        "nextStatement": null,
                        "colour": pxt.toolbox.blockColors['arrays'],
                        "inputsInline": true
                    });
                    setBuiltinHelpInfo(this, listsIndexSetId);
                }
            };
        }
        function initMath() {
            // math_op2
            const mathOp2Id = "math_op2";
            const mathOp2Def = pxt.blocks.getBlockDefinition(mathOp2Id);
            const mathOp2Tooltips = mathOp2Def.tooltip;
            Blockly.Blocks[mathOp2Id] = {
                init: function () {
                    this.jsonInit({
                        "message0": lf("%1 of %2 and %3"),
                        "args0": [
                            {
                                "type": "field_dropdown",
                                "name": "op",
                                "options": [
                                    [lf("{id:op}min"), "min"],
                                    [lf("{id:op}max"), "max"]
                                ]
                            },
                            {
                                "type": "input_value",
                                "name": "x",
                                "check": "Number"
                            },
                            {
                                "type": "input_value",
                                "name": "y",
                                "check": "Number"
                            }
                        ],
                        "inputsInline": true,
                        "output": "Number",
                        "outputShape": Blockly.OUTPUT_SHAPE_ROUND,
                        "colour": pxt.toolbox.getNamespaceColor('math')
                    });
                    let thisBlock = this;
                    setHelpResources(this, mathOp2Id, mathOp2Def.name, function (block) {
                        return mathOp2Tooltips[block.getFieldValue('op')];
                    }, mathOp2Def.url, pxt.toolbox.getNamespaceColor(mathOp2Def.category));
                }
            };
            // math_op3
            const mathOp3Id = "math_op3";
            const mathOp3Def = pxt.blocks.getBlockDefinition(mathOp3Id);
            Blockly.Blocks[mathOp3Id] = {
                init: function () {
                    this.jsonInit({
                        "message0": mathOp3Def.block["message0"],
                        "args0": [
                            {
                                "type": "input_value",
                                "name": "x",
                                "check": "Number"
                            }
                        ],
                        "inputsInline": true,
                        "output": "Number",
                        "outputShape": Blockly.OUTPUT_SHAPE_ROUND,
                        "colour": pxt.toolbox.getNamespaceColor('math')
                    });
                    setBuiltinHelpInfo(this, mathOp3Id);
                }
            };
            // builtin math_number, math_integer, math_whole_number, math_number_minmax
            //XXX Integer validation needed.
            const numberBlocks = ['math_number', 'math_integer', 'math_whole_number', 'math_number_minmax'];
            numberBlocks.forEach(num_id => {
                const mInfo = pxt.blocks.getBlockDefinition(num_id);
                installHelpResources(num_id, mInfo.name, mInfo.tooltip, mInfo.url, Blockly.Colours.textField, Blockly.Colours.textField, Blockly.Colours.textField);
            });
            // builtin math_arithmetic
            const msg = Blockly.Msg;
            const mathArithmeticId = "math_arithmetic";
            const mathArithmeticDef = pxt.blocks.getBlockDefinition(mathArithmeticId);
            const mathArithmeticTooltips = mathArithmeticDef.tooltip;
            msg.MATH_ADDITION_SYMBOL = mathArithmeticDef.block["MATH_ADDITION_SYMBOL"];
            msg.MATH_SUBTRACTION_SYMBOL = mathArithmeticDef.block["MATH_SUBTRACTION_SYMBOL"];
            msg.MATH_MULTIPLICATION_SYMBOL = mathArithmeticDef.block["MATH_MULTIPLICATION_SYMBOL"];
            msg.MATH_DIVISION_SYMBOL = mathArithmeticDef.block["MATH_DIVISION_SYMBOL"];
            msg.MATH_POWER_SYMBOL = mathArithmeticDef.block["MATH_POWER_SYMBOL"];
            installHelpResources(mathArithmeticId, mathArithmeticDef.name, function (block) {
                return mathArithmeticTooltips[block.getFieldValue('OP')];
            }, mathArithmeticDef.url, pxt.toolbox.getNamespaceColor(mathArithmeticDef.category));
            // builtin math_modulo
            const mathModuloId = "math_modulo";
            const mathModuloDef = pxt.blocks.getBlockDefinition(mathModuloId);
            msg.MATH_MODULO_TITLE = mathModuloDef.block["MATH_MODULO_TITLE"];
            installBuiltinHelpInfo(mathModuloId);
            blocks_4.initMathOpBlock();
            blocks_4.initMathRoundBlock();
        }
        function initVariables() {
            // We only give types to "special" variables like enum members and we don't
            // want those showing up in the variable dropdown so filter the variables
            // that show up to only ones that have an empty type
            Blockly.FieldVariable.prototype.getVariableTypes_ = () => [""];
            let varname = lf("{id:var}item");
            Blockly.Variables.flyoutCategory = function (workspace) {
                let xmlList = [];
                if (!pxt.appTarget.appTheme.hideFlyoutHeadings) {
                    // Add the Heading label
                    let headingLabel = createFlyoutHeadingLabel(lf("Variables"), pxt.toolbox.getNamespaceColor('variables'), pxt.toolbox.getNamespaceIcon('variables'));
                    xmlList.push(headingLabel);
                }
                let button = document.createElement('button');
                button.setAttribute('text', lf("Make a Variable..."));
                button.setAttribute('callbackKey', 'CREATE_VARIABLE');
                workspace.registerButtonCallback('CREATE_VARIABLE', function (button) {
                    Blockly.Variables.createVariable(button.getTargetWorkspace());
                });
                xmlList.push(button);
                let blockList = Blockly.Variables.flyoutCategoryBlocks(workspace);
                xmlList = xmlList.concat(blockList);
                return xmlList;
            };
            Blockly.Variables.flyoutCategoryBlocks = function (workspace) {
                let variableModelList = workspace.getVariablesOfType('');
                let xmlList = [];
                if (variableModelList.length > 0) {
                    let mostRecentVariable = variableModelList[variableModelList.length - 1];
                    variableModelList.sort(Blockly.VariableModel.compareByName);
                    // variables getters first
                    for (let i = 0; i < variableModelList.length; i++) {
                        const variable = variableModelList[i];
                        if (Blockly.Blocks['variables_get']) {
                            let blockText = '<xml>' +
                                '<block type="variables_get" gap="8">' +
                                Blockly.Variables.generateVariableFieldXmlString(variable) +
                                '</block>' +
                                '</xml>';
                            let block = Blockly.Xml.textToDom(blockText).firstChild;
                            xmlList.push(block);
                        }
                    }
                    xmlList[xmlList.length - 1].setAttribute('gap', '24');
                    if (Blockly.Blocks['variables_change'] || Blockly.Blocks['variables_set']) {
                        xmlList.unshift(createFlyoutGroupLabel("Your Variables"));
                    }
                    if (Blockly.Blocks['variables_change']) {
                        let gap = Blockly.Blocks['variables_get'] ? 20 : 8;
                        let blockText = '<xml>' +
                            '<block type="variables_change" gap="' + gap + '">' +
                            Blockly.Variables.generateVariableFieldXmlString(mostRecentVariable) +
                            '</block>' +
                            '</xml>';
                        let block = Blockly.Xml.textToDom(blockText).firstChild;
                        {
                            let value = goog.dom.createDom('value');
                            value.setAttribute('name', 'VALUE');
                            let shadow = goog.dom.createDom('shadow');
                            shadow.setAttribute("type", "math_number");
                            value.appendChild(shadow);
                            let field = goog.dom.createDom('field');
                            field.setAttribute('name', 'NUM');
                            field.appendChild(document.createTextNode("1"));
                            shadow.appendChild(field);
                            block.appendChild(value);
                        }
                        xmlList.unshift(block);
                    }
                    if (Blockly.Blocks['variables_set']) {
                        let gap = Blockly.Blocks['variables_change'] ? 8 : 24;
                        let blockText = '<xml>' +
                            '<block type="variables_set" gap="' + gap + '">' +
                            Blockly.Variables.generateVariableFieldXmlString(mostRecentVariable) +
                            '</block>' +
                            '</xml>';
                        let block = Blockly.Xml.textToDom(blockText).firstChild;
                        {
                            let value = goog.dom.createDom('value');
                            value.setAttribute('name', 'VALUE');
                            let shadow = goog.dom.createDom('shadow');
                            shadow.setAttribute("type", "math_number");
                            value.appendChild(shadow);
                            let field = goog.dom.createDom('field');
                            field.setAttribute('name', 'NUM');
                            field.appendChild(document.createTextNode("0"));
                            shadow.appendChild(field);
                            block.appendChild(value);
                        }
                        xmlList.unshift(block);
                    }
                }
                return xmlList;
            };
            // builtin variables_get
            const msg = Blockly.Msg;
            const variablesGetId = "variables_get";
            const variablesGetDef = pxt.blocks.getBlockDefinition(variablesGetId);
            msg.VARIABLES_GET_CREATE_SET = variablesGetDef.block["VARIABLES_GET_CREATE_SET"];
            installBuiltinHelpInfo(variablesGetId);
            const variablesReporterGetId = "variables_get_reporter";
            installBuiltinHelpInfo(variablesReporterGetId);
            // Dropdown menu of variables_get
            msg.RENAME_VARIABLE = lf("Rename variable...");
            msg.DELETE_VARIABLE = lf("Delete the \"%1\" variable");
            msg.DELETE_VARIABLE_CONFIRMATION = lf("Delete %1 uses of the \"%2\" variable?");
            msg.NEW_VARIABLE_DROPDOWN = lf("New variable...");
            // builtin variables_set
            const variablesSetId = "variables_set";
            const variablesSetDef = pxt.blocks.getBlockDefinition(variablesSetId);
            msg.VARIABLES_SET = variablesSetDef.block["VARIABLES_SET"];
            msg.VARIABLES_DEFAULT_NAME = varname;
            msg.VARIABLES_SET_CREATE_GET = lf("Create 'get %1'");
            installBuiltinHelpInfo(variablesSetId);
            // pxt variables_change
            const variablesChangeId = "variables_change";
            const variablesChangeDef = pxt.blocks.getBlockDefinition(variablesChangeId);
            Blockly.Blocks[variablesChangeId] = {
                init: function () {
                    this.jsonInit({
                        "message0": variablesChangeDef.block["message0"],
                        "args0": [
                            {
                                "type": "field_variable",
                                "name": "VAR",
                                "variable": varname
                            },
                            {
                                "type": "input_value",
                                "name": "VALUE",
                                "check": "Number"
                            }
                        ],
                        "inputsInline": true,
                        "previousStatement": null,
                        "nextStatement": null,
                        "colour": pxt.toolbox.getNamespaceColor('variables')
                    });
                    setBuiltinHelpInfo(this, variablesChangeId);
                },
                /**
                 * Add menu option to create getter block for this variable
                 * @param {!Array} options List of menu options to add to.
                 * @this Blockly.Block
                 */
                customContextMenu: function (options) {
                    if (!(this.inDebugWorkspace())) {
                        let option = {
                            enabled: this.workspace.remainingCapacity() > 0
                        };
                        let name = this.getField("VAR").getText();
                        option.text = lf("Create 'get {0}'", name);
                        let xmlField = goog.dom.createDom('field', null, name);
                        xmlField.setAttribute('name', 'VAR');
                        let xmlBlock = goog.dom.createDom('block', null, xmlField);
                        xmlBlock.setAttribute('type', "variables_get");
                        option.callback = Blockly.ContextMenu.callbackFactory(this, xmlBlock);
                        options.push(option);
                    }
                }
            };
            // New variable dialog
            msg.NEW_VARIABLE_TITLE = lf("New variable name:");
            // Rename variable dialog
            msg.RENAME_VARIABLE_TITLE = lf("Rename all '%1' variables to:");
        }
        function initFunctions() {
            const msg = Blockly.Msg;
            // New functions implementation messages
            msg.FUNCTION_CREATE_NEW = lf("Make a Function...");
            msg.FUNCTION_WARNING_DUPLICATE_ARG = lf("Functions cannot use the same argument name more than once.");
            msg.FUNCTION_WARNING_ARG_NAME_IS_FUNCTION_NAME = lf("Argument names must not be the same as the function name.");
            msg.FUNCTION_WARNING_EMPTY_NAME = lf("Function and argument names cannot be empty.");
            msg.FUNCTIONS_DEFAULT_FUNCTION_NAME = lf("doSomething");
            msg.FUNCTIONS_DEFAULT_BOOLEAN_ARG_NAME = lf("bool");
            msg.FUNCTIONS_DEFAULT_STRING_ARG_NAME = lf("text");
            msg.FUNCTIONS_DEFAULT_NUMBER_ARG_NAME = lf("num");
            msg.FUNCTIONS_DEFAULT_CUSTOM_ARG_NAME = lf("arg");
            msg.PROCEDURES_HUE = pxt.toolbox.getNamespaceColor("functions");
            msg.REPORTERS_HUE = pxt.toolbox.getNamespaceColor("variables");
            // builtin procedures_defnoreturn
            const proceduresDefId = "procedures_defnoreturn";
            const proceduresDef = pxt.blocks.getBlockDefinition(proceduresDefId);
            msg.PROCEDURES_DEFNORETURN_TITLE = proceduresDef.block["PROCEDURES_DEFNORETURN_TITLE"];
            msg.PROCEDURE_ALREADY_EXISTS = proceduresDef.block["PROCEDURE_ALREADY_EXISTS"];
            (Blockly.Blocks['procedures_defnoreturn']).init = function () {
                let nameField = new Blockly.FieldTextInput('', Blockly.Procedures.rename);
                //nameField.setSpellcheck(false); //TODO
                this.appendDummyInput()
                    .appendField(Blockly.Msg.PROCEDURES_DEFNORETURN_TITLE)
                    .appendField(nameField, 'NAME')
                    .appendField('', 'PARAMS');
                this.setColour(pxt.toolbox.getNamespaceColor('functions'));
                this.arguments_ = [];
                this.argumentVarModels_ = [];
                this.setStartHat(true);
                this.setStatements_(true);
                this.statementConnection_ = null;
            };
            installBuiltinHelpInfo(proceduresDefId);
            // builtin procedures_defnoreturn
            const proceduresCallId = "procedures_callnoreturn";
            const proceduresCallDef = pxt.blocks.getBlockDefinition(proceduresCallId);
            msg.PROCEDURES_CALLRETURN_TOOLTIP = proceduresDef.tooltip.toString();
            Blockly.Blocks['procedures_callnoreturn'] = {
                init: function () {
                    let nameField = new pxtblockly.FieldProcedure('');
                    this.appendDummyInput('TOPROW')
                        .appendField(proceduresCallDef.block['PROCEDURES_CALLNORETURN_TITLE'])
                        .appendField(nameField, 'NAME');
                    this.setPreviousStatement(true);
                    this.setNextStatement(true);
                    this.setColour(pxt.toolbox.getNamespaceColor('functions'));
                    this.arguments_ = [];
                    this.quarkConnections_ = {};
                    this.quarkIds_ = null;
                },
                /**
                 * Returns the name of the procedure this block calls.
                 * @return {string} Procedure name.
                 * @this Blockly.Block
                 */
                getProcedureCall: function () {
                    // The NAME field is guaranteed to exist, null will never be returned.
                    return /** @type {string} */ (this.getFieldValue('NAME'));
                },
                /**
                 * Notification that a procedure is renaming.
                 * If the name matches this block's procedure, rename it.
                 * @param {string} oldName Previous name of procedure.
                 * @param {string} newName Renamed procedure.
                 * @this Blockly.Block
                 */
                renameProcedure: function (oldName, newName) {
                    if (Blockly.Names.equals(oldName, this.getProcedureCall())) {
                        this.setFieldValue(newName, 'NAME');
                    }
                },
                /**
                 * Procedure calls cannot exist without the corresponding procedure
                 * definition.  Enforce this link whenever an event is fired.
                 * @param {!Blockly.Events.Abstract} event Change event.
                 * @this Blockly.Block
                 */
                onchange: function (event) {
                    if (!this.workspace || this.workspace.isFlyout || this.isInsertionMarker()) {
                        // Block is deleted or is in a flyout or insertion marker.
                        return;
                    }
                    if (event.type == Blockly.Events.CREATE &&
                        event.ids.indexOf(this.id) != -1) {
                        // Look for the case where a procedure call was created (usually through
                        // paste) and there is no matching definition.  In this case, create
                        // an empty definition block with the correct signature.
                        let name = this.getProcedureCall();
                        let def = Blockly.Procedures.getDefinition(name, this.workspace);
                        if (def && (def.type != this.defType_ ||
                            JSON.stringify(def.arguments_) != JSON.stringify(this.arguments_))) {
                            // The signatures don't match.
                            def = null;
                        }
                        if (!def) {
                            Blockly.Events.setGroup(event.group);
                            /**
                             * Create matching definition block.
                             * <xml>
                             *   <block type="procedures_defreturn" x="10" y="20">
                             *     <field name="NAME">test</field>
                             *   </block>
                             * </xml>
                             */
                            let xml = Blockly.utils.xml.createElement('xml');
                            let block = Blockly.utils.xml.createElement('block');
                            block.setAttribute('type', this.defType_);
                            let xy = this.getRelativeToSurfaceXY();
                            let x = xy.x + Blockly.SNAP_RADIUS * (this.RTL ? -1 : 1);
                            let y = xy.y + Blockly.SNAP_RADIUS * 2;
                            block.setAttribute('x', x);
                            block.setAttribute('y', y);
                            let field = Blockly.utils.xml.createElement('field');
                            field.setAttribute('name', 'NAME');
                            field.appendChild(document.createTextNode(this.getProcedureCall()));
                            block.appendChild(field);
                            xml.appendChild(block);
                            pxt.blocks.domToWorkspaceNoEvents(xml, this.workspace);
                            Blockly.Events.setGroup(false);
                        }
                    }
                    else if (event.type == Blockly.Events.DELETE) {
                        // Look for the case where a procedure definition has been deleted,
                        // leaving this block (a procedure call) orphaned.  In this case, delete
                        // the orphan.
                        let name = this.getProcedureCall();
                        let def = Blockly.Procedures.getDefinition(name, this.workspace);
                        if (!def) {
                            Blockly.Events.setGroup(event.group);
                            this.dispose(true, false);
                            Blockly.Events.setGroup(false);
                        }
                    }
                },
                mutationToDom: function () {
                    const mutationElement = document.createElement("mutation");
                    mutationElement.setAttribute("name", this.getProcedureCall());
                    return mutationElement;
                },
                domToMutation: function (element) {
                    const name = element.getAttribute("name");
                    this.renameProcedure(this.getProcedureCall(), name);
                },
                /**
                 * Add menu option to find the definition block for this call.
                 * @param {!Array} options List of menu options to add to.
                 * @this Blockly.Block
                 */
                customContextMenu: function (options) {
                    let option = { enabled: true };
                    option.text = Blockly.Msg.PROCEDURES_HIGHLIGHT_DEF;
                    let name = this.getProcedureCall();
                    let workspace = this.workspace;
                    option.callback = function () {
                        let def = Blockly.Procedures.getDefinition(name, workspace);
                        if (def)
                            def.select();
                    };
                    options.push(option);
                },
                defType_: 'procedures_defnoreturn'
            };
            installBuiltinHelpInfo(proceduresCallId);
            // New functions implementation function_definition
            const functionDefinitionId = "function_definition";
            const functionDefinition = pxt.blocks.getBlockDefinition(functionDefinitionId);
            msg.FUNCTIONS_EDIT_OPTION = functionDefinition.block["FUNCTIONS_EDIT_OPTION"];
            installBuiltinHelpInfo(functionDefinitionId);
            // New functions implementation function_call
            const functionCallId = "function_call";
            const functionCall = pxt.blocks.getBlockDefinition(functionCallId);
            msg.FUNCTIONS_CALL_TITLE = functionCall.block["FUNCTIONS_CALL_TITLE"];
            msg.FUNCTIONS_GO_TO_DEFINITION_OPTION = functionCall.block["FUNCTIONS_GO_TO_DEFINITION_OPTION"];
            installBuiltinHelpInfo(functionCallId);
            installBuiltinHelpInfo("function_call_output");
            const functionReturnId = "function_return";
            Blockly.Blocks[functionReturnId] = {
                init: function () {
                    blocks_4.initReturnStatement(this);
                },
                onchange: function (event) {
                    const block = this;
                    if (!block.workspace || block.workspace.isFlyout) {
                        // Block is deleted or is in a flyout.
                        return;
                    }
                    const thisWasCreated = event.type === Blockly.Events.BLOCK_CREATE && event.ids.indexOf(block.id) != -1;
                    const thisWasDragged = event.type === Blockly.Events.END_DRAG && event.allNestedIds.indexOf(block.id) != -1;
                    if (thisWasCreated || thisWasDragged) {
                        const rootBlock = block.getRootBlock();
                        const isTopBlock = rootBlock.type === functionReturnId;
                        if (isTopBlock || rootBlock.previousConnection != null) {
                            // Statement is by itself on the workspace, or it is slotted into a
                            // stack of statements that is not attached to a function or event. Let
                            // it exist until it is connected to a function
                            return;
                        }
                        if (rootBlock.type !== functionDefinitionId) {
                            // Not a function block, so disconnect
                            Blockly.Events.setGroup(event.group);
                            block.previousConnection.disconnect();
                            Blockly.Events.setGroup(false);
                        }
                    }
                }
            };
            installBuiltinHelpInfo(functionReturnId);
            Blockly.Procedures.flyoutCategory = function (workspace) {
                let xmlList = [];
                if (!pxt.appTarget.appTheme.hideFlyoutHeadings) {
                    // Add the Heading label
                    let headingLabel = createFlyoutHeadingLabel(lf("Functions"), pxt.toolbox.getNamespaceColor('functions'), pxt.toolbox.getNamespaceIcon('functions'), 'blocklyFlyoutIconfunctions');
                    xmlList.push(headingLabel);
                }
                const newFunction = lf("Make a Function...");
                const newFunctionTitle = lf("New function name:");
                // Add the "Make a function" button
                let button = Blockly.utils.xml.createElement('button');
                button.setAttribute('text', newFunction);
                button.setAttribute('callbackKey', 'CREATE_FUNCTION');
                let createFunction = (name) => {
                    /**
                     * Create matching definition block.
                     * <xml>
                     *   <block type="procedures_defreturn" x="10" y="20">
                     *     <field name="NAME">test</field>
                     *   </block>
                     * </xml>
                     */
                    let topBlock = workspace.getTopBlocks(true)[0];
                    let x = 10, y = 10;
                    if (topBlock) {
                        let xy = topBlock.getRelativeToSurfaceXY();
                        x = xy.x + Blockly.SNAP_RADIUS * (topBlock.RTL ? -1 : 1);
                        y = xy.y + Blockly.SNAP_RADIUS * 2;
                    }
                    let xml = Blockly.utils.xml.createElement('xml');
                    let block = Blockly.utils.xml.createElement('block');
                    block.setAttribute('type', 'procedures_defnoreturn');
                    block.setAttribute('x', String(x));
                    block.setAttribute('y', String(y));
                    let field = Blockly.utils.xml.createElement('field');
                    field.setAttribute('name', 'NAME');
                    field.appendChild(document.createTextNode(name));
                    block.appendChild(field);
                    xml.appendChild(block);
                    let newBlockIds = pxt.blocks.domToWorkspaceNoEvents(xml, workspace);
                    // Close flyout and highlight block
                    Blockly.hideChaff();
                    let newBlock = workspace.getBlockById(newBlockIds[0]);
                    newBlock.select();
                    // Center on the new block so we know where it is
                    workspace.centerOnBlock(newBlock.id);
                };
                workspace.registerButtonCallback('CREATE_FUNCTION', function (button) {
                    let promptAndCheckWithAlert = (defaultName) => {
                        Blockly.prompt(newFunctionTitle, defaultName, function (newFunc) {
                            pxt.tickEvent('blocks.makeafunction');
                            // Merge runs of whitespace.  Strip leading and trailing whitespace.
                            // Beyond this, all names are legal.
                            if (newFunc) {
                                newFunc = newFunc.replace(/[\s\xa0]+/g, ' ').replace(/^ | $/g, '');
                                if (newFunc == newFunction) {
                                    // Ok, not ALL names are legal...
                                    newFunc = null;
                                }
                            }
                            if (newFunc) {
                                if (workspace.getVariable(newFunc)) {
                                    Blockly.alert(Blockly.Msg.VARIABLE_ALREADY_EXISTS.replace('%1', newFunc.toLowerCase()), function () {
                                        promptAndCheckWithAlert(newFunc); // Recurse
                                    });
                                }
                                else if (!Blockly.Procedures.isLegalName_(newFunc, workspace)) {
                                    Blockly.alert(Blockly.Msg.PROCEDURE_ALREADY_EXISTS.replace('%1', newFunc.toLowerCase()), function () {
                                        promptAndCheckWithAlert(newFunc); // Recurse
                                    });
                                }
                                else {
                                    createFunction(newFunc);
                                }
                            }
                        });
                    };
                    promptAndCheckWithAlert('doSomething');
                });
                xmlList.push(button);
                function populateProcedures(procedureList, templateName) {
                    for (let i = 0; i < procedureList.length; i++) {
                        let name = procedureList[i][0];
                        let args = procedureList[i][1];
                        // <block type="procedures_callnoreturn" gap="16">
                        //   <field name="NAME">name</field>
                        // </block>
                        let block = Blockly.utils.xml.createElement('block');
                        block.setAttribute('type', templateName);
                        block.setAttribute('gap', '16');
                        block.setAttribute('colour', pxt.toolbox.getNamespaceColor('functions'));
                        let field = goog.dom.createDom('field', null, name);
                        field.setAttribute('name', 'NAME');
                        block.appendChild(field);
                        xmlList.push(block);
                    }
                }
                let tuple = Blockly.Procedures.allProcedures(workspace);
                populateProcedures(tuple[0], 'procedures_callnoreturn');
                return xmlList;
            };
            // Patch new functions flyout to add the heading
            const oldFlyout = Blockly.Functions.flyoutCategory;
            Blockly.Functions.flyoutCategory = (workspace) => {
                const elems = oldFlyout(workspace);
                if (elems.length > 1) {
                    let returnBlock = mkReturnStatementBlock();
                    // Add divider
                    elems.splice(1, 0, createFlyoutGroupLabel("Your Functions"));
                    // Insert after the "make a function" button
                    elems.splice(1, 0, returnBlock);
                }
                const functionsWithReturn = Blockly.Functions.getAllFunctionDefinitionBlocks(workspace)
                    .filter(def => def.getDescendants(false).some(child => child.type === "function_return" && child.getInputTargetBlock("RETURN_VALUE")))
                    .map(def => def.getField("function_name").getText());
                const headingLabel = createFlyoutHeadingLabel(lf("Functions"), pxt.toolbox.getNamespaceColor('functions'), pxt.toolbox.getNamespaceIcon('functions'), 'blocklyFlyoutIconfunctions');
                elems.unshift(headingLabel);
                const res = [];
                for (const e of elems) {
                    res.push(e);
                    if (e.getAttribute("type") === "function_call") {
                        const mutation = e.children.item(0);
                        if (mutation) {
                            const name = mutation.getAttribute("name");
                            if (functionsWithReturn.some(n => n === name)) {
                                const clone = e.cloneNode(true);
                                clone.setAttribute("type", "function_call_output");
                                res.push(clone);
                            }
                        }
                    }
                }
                return res;
            };
            // Configure function editor argument icons
            const iconsMap = {
                number: pxt.blocks.defaultIconForArgType("number"),
                boolean: pxt.blocks.defaultIconForArgType("boolean"),
                string: pxt.blocks.defaultIconForArgType("string"),
                Array: pxt.blocks.defaultIconForArgType("Array")
            };
            const customNames = {};
            const functionOptions = pxt.appTarget.runtime && pxt.appTarget.runtime.functionsOptions;
            if (functionOptions && functionOptions.extraFunctionEditorTypes) {
                functionOptions.extraFunctionEditorTypes.forEach(t => {
                    iconsMap[t.typeName] = t.icon || pxt.blocks.defaultIconForArgType();
                    if (t.defaultName) {
                        customNames[t.typeName] = t.defaultName;
                    }
                });
            }
            Blockly.PXTBlockly.FunctionUtils.argumentIcons = iconsMap;
            Blockly.PXTBlockly.FunctionUtils.argumentDefaultNames = customNames;
            if (Blockly.Blocks["argument_reporter_custom"]) {
                // The logic for setting the output check relies on the internals of PXT
                // too much to be refactored into pxt-blockly, so we need to monkey patch
                // it here
                (Blockly.Blocks["argument_reporter_custom"]).domToMutation = function (xmlElement) {
                    const typeName = xmlElement.getAttribute('typename');
                    this.typeName_ = typeName;
                    setOutputCheck(this, typeName, cachedBlockInfo);
                };
            }
            /**
             * Make a context menu option for creating a function call block.
             * This appears in the context menu for function definitions.
             * @param {!Blockly.BlockSvg} block The block where the right-click originated.
             * @return {!Object} A menu option, containing text, enabled, and a callback.
             * @package
             */
            const makeCreateCallOptionOriginal = Blockly.Functions.makeCreateCallOption;
            // needs to exist or makeCreateCallOptionOriginal will throw an exception
            Blockly.Msg.FUNCTIONS_CREATE_CALL_OPTION = "";
            Blockly.Functions.makeCreateCallOption = function (block) {
                let option = makeCreateCallOptionOriginal(block);
                let functionName = block.getField("function_name").getText();
                option.text = pxt.Util.lf("Create 'call {0}'", functionName);
                return option;
            };
        }
        function initLogic() {
            const msg = Blockly.Msg;
            // builtin controls_if
            const controlsIfId = "controls_if";
            const controlsIfDef = pxt.blocks.getBlockDefinition(controlsIfId);
            const controlsIfTooltips = controlsIfDef.tooltip;
            msg.CONTROLS_IF_MSG_IF = controlsIfDef.block["CONTROLS_IF_MSG_IF"];
            msg.CONTROLS_IF_MSG_THEN = controlsIfDef.block["CONTROLS_IF_MSG_THEN"];
            msg.CONTROLS_IF_MSG_ELSE = controlsIfDef.block["CONTROLS_IF_MSG_ELSE"];
            msg.CONTROLS_IF_MSG_ELSEIF = controlsIfDef.block["CONTROLS_IF_MSG_ELSEIF"];
            msg.CONTROLS_IF_TOOLTIP_1 = controlsIfTooltips["CONTROLS_IF_TOOLTIP_1"];
            msg.CONTROLS_IF_TOOLTIP_2 = controlsIfTooltips["CONTROLS_IF_TOOLTIP_2"];
            msg.CONTROLS_IF_TOOLTIP_3 = controlsIfTooltips["CONTROLS_IF_TOOLTIP_3"];
            msg.CONTROLS_IF_TOOLTIP_4 = controlsIfTooltips["CONTROLS_IF_TOOLTIP_4"];
            installBuiltinHelpInfo(controlsIfId);
            // builtin logic_compare
            const logicCompareId = "logic_compare";
            const logicCompareDef = pxt.blocks.getBlockDefinition(logicCompareId);
            const logicCompareTooltips = logicCompareDef.tooltip;
            msg.LOGIC_COMPARE_TOOLTIP_EQ = logicCompareTooltips["LOGIC_COMPARE_TOOLTIP_EQ"];
            msg.LOGIC_COMPARE_TOOLTIP_NEQ = logicCompareTooltips["LOGIC_COMPARE_TOOLTIP_NEQ"];
            msg.LOGIC_COMPARE_TOOLTIP_LT = logicCompareTooltips["LOGIC_COMPARE_TOOLTIP_LT"];
            msg.LOGIC_COMPARE_TOOLTIP_LTE = logicCompareTooltips["LOGIC_COMPARE_TOOLTIP_LTE"];
            msg.LOGIC_COMPARE_TOOLTIP_GT = logicCompareTooltips["LOGIC_COMPARE_TOOLTIP_GT"];
            msg.LOGIC_COMPARE_TOOLTIP_GTE = logicCompareTooltips["LOGIC_COMPARE_TOOLTIP_GTE"];
            installBuiltinHelpInfo(logicCompareId);
            // builtin logic_operation
            const logicOperationId = "logic_operation";
            const logicOperationDef = pxt.blocks.getBlockDefinition(logicOperationId);
            const logicOperationTooltips = logicOperationDef.tooltip;
            msg.LOGIC_OPERATION_AND = logicOperationDef.block["LOGIC_OPERATION_AND"];
            msg.LOGIC_OPERATION_OR = logicOperationDef.block["LOGIC_OPERATION_OR"];
            msg.LOGIC_OPERATION_TOOLTIP_AND = logicOperationTooltips["LOGIC_OPERATION_TOOLTIP_AND"];
            msg.LOGIC_OPERATION_TOOLTIP_OR = logicOperationTooltips["LOGIC_OPERATION_TOOLTIP_OR"];
            installBuiltinHelpInfo(logicOperationId);
            // builtin logic_negate
            const logicNegateId = "logic_negate";
            const logicNegateDef = pxt.blocks.getBlockDefinition(logicNegateId);
            msg.LOGIC_NEGATE_TITLE = logicNegateDef.block["LOGIC_NEGATE_TITLE"];
            installBuiltinHelpInfo(logicNegateId);
            // builtin logic_boolean
            const logicBooleanId = "logic_boolean";
            const logicBooleanDef = pxt.blocks.getBlockDefinition(logicBooleanId);
            msg.LOGIC_BOOLEAN_TRUE = logicBooleanDef.block["LOGIC_BOOLEAN_TRUE"];
            msg.LOGIC_BOOLEAN_FALSE = logicBooleanDef.block["LOGIC_BOOLEAN_FALSE"];
            installBuiltinHelpInfo(logicBooleanId);
        }
        function initText() {
            // builtin text
            const textInfo = pxt.blocks.getBlockDefinition('text');
            installHelpResources('text', textInfo.name, textInfo.tooltip, textInfo.url, Blockly.Colours.textField, Blockly.Colours.textField, Blockly.Colours.textField);
            // builtin text_length
            const msg = Blockly.Msg;
            const textLengthId = "text_length";
            const textLengthDef = pxt.blocks.getBlockDefinition(textLengthId);
            msg.TEXT_LENGTH_TITLE = textLengthDef.block["TEXT_LENGTH_TITLE"];
            // We have to override this block definition because the builtin block
            // allows both Strings and Arrays in its input check and that confuses
            // our Blockly compiler
            let block = Blockly.Blocks[textLengthId];
            block.init = function () {
                this.jsonInit({
                    "message0": msg.TEXT_LENGTH_TITLE,
                    "args0": [
                        {
                            "type": "input_value",
                            "name": "VALUE",
                            "check": ['String']
                        }
                    ],
                    "output": 'Number',
                    "outputShape": Blockly.OUTPUT_SHAPE_ROUND
                });
            };
            installBuiltinHelpInfo(textLengthId);
            // builtin text_join
            const textJoinId = "text_join";
            const textJoinDef = pxt.blocks.getBlockDefinition(textJoinId);
            msg.TEXT_JOIN_TITLE_CREATEWITH = textJoinDef.block["TEXT_JOIN_TITLE_CREATEWITH"];
            installBuiltinHelpInfo(textJoinId);
        }
        function initDebugger() {
            Blockly.Blocks[pxtc.TS_DEBUGGER_TYPE] = {
                init: function () {
                    let that = this;
                    that.setColour(pxt.toolbox.getNamespaceColor('debug'));
                    that.setPreviousStatement(true);
                    that.setNextStatement(true);
                    that.setInputsInline(false);
                    that.appendDummyInput('ON_OFF')
                        .appendField(new Blockly.FieldLabel(lf("breakpoint"), undefined), "DEBUGGER")
                        .appendField(new pxtblockly.FieldBreakpoint("1", { 'type': 'number' }), "ON_OFF");
                    setHelpResources(this, pxtc.TS_DEBUGGER_TYPE, lf("Debugger statement"), lf("A debugger statement invokes any available debugging functionality"), '/javascript/debugger', pxt.toolbox.getNamespaceColor('debug'));
                }
            };
        }
        function initComments() {
            Blockly.Msg.WORKSPACE_COMMENT_DEFAULT_TEXT = '';
        }
        function initTooltip() {
            const renderTip = (el) => {
                if (el.disabled)
                    return lf("This block is disabled and will not run. Attach this block to an event to enable it.");
                let tip = el.tooltip;
                while (goog.isFunction(tip)) {
                    tip = tip(el);
                }
                return tip;
            };
            /**
             * Override Blockly tooltip rendering with our own.
             * TODO shakao check if tooltip can be modified in a cleaner way
             * @private
             */
            Blockly.Tooltip.show_ = function () {
                const BlocklyTooltip = Blockly.Tooltip;
                BlocklyTooltip.poisonedElement_ = BlocklyTooltip.element_;
                if (!Blockly.Tooltip.DIV) {
                    return;
                }
                // Erase all existing text.
                goog.dom.removeChildren(/** @type {!Element} */ (Blockly.Tooltip.DIV));
                // Get the new text.
                const card = BlocklyTooltip.element_.codeCard;
                function render() {
                    let rtl = BlocklyTooltip.element_.RTL;
                    let windowSize = goog.dom.getViewportSize();
                    // Display the tooltip.
                    let tooltip = Blockly.Tooltip.DIV;
                    tooltip.style.direction = rtl ? 'rtl' : 'ltr';
                    tooltip.style.display = 'block';
                    Blockly.Tooltip.visible = true;
                    // Move the tooltip to just below the cursor.
                    let anchorX = BlocklyTooltip.lastX_;
                    if (rtl) {
                        anchorX -= Blockly.Tooltip.OFFSET_X + tooltip.offsetWidth;
                    }
                    else {
                        anchorX += Blockly.Tooltip.OFFSET_X;
                    }
                    let anchorY = BlocklyTooltip.lastY_ + Blockly.Tooltip.OFFSET_Y;
                    if (anchorY + tooltip.offsetHeight >
                        windowSize.height + window.scrollY) {
                        // Falling off the bottom of the screen; shift the tooltip up.
                        anchorY -= tooltip.offsetHeight + 2 * Blockly.Tooltip.OFFSET_Y;
                    }
                    if (rtl) {
                        // Prevent falling off left edge in RTL mode.
                        anchorX = Math.max(Blockly.Tooltip.MARGINS - window.scrollX, anchorX);
                    }
                    else {
                        if (anchorX + tooltip.offsetWidth >
                            windowSize.width + window.scrollX - 2 * Blockly.Tooltip.MARGINS) {
                            // Falling off the right edge of the screen;
                            // clamp the tooltip on the edge.
                            anchorX = windowSize.width - tooltip.offsetWidth -
                                2 * Blockly.Tooltip.MARGINS;
                        }
                    }
                    tooltip.style.top = anchorY + 'px';
                    tooltip.style.left = anchorX + 'px';
                }
                if (card) {
                    const cardEl = pxt.docs.codeCard.render({
                        header: renderTip(BlocklyTooltip.element_)
                    });
                    Blockly.Tooltip.DIV.appendChild(cardEl);
                    render();
                }
                else {
                    let tip = renderTip(BlocklyTooltip.element_);
                    tip = Blockly.utils._string.wrap(tip, Blockly.Tooltip.LIMIT);
                    // Create new text, line by line.
                    let lines = tip.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        let div = document.createElement('div');
                        div.appendChild(document.createTextNode(lines[i]));
                        Blockly.Tooltip.DIV.appendChild(div);
                    }
                    render();
                }
            };
        }
        function removeBlock(fn) {
            delete Blockly.Blocks[fn.attributes.blockId];
            delete cachedBlocks[fn.attributes.blockId];
        }
        /**
         * <block type="pxt_wait_until">
         *     <value name="PREDICATE">
         *          <shadow type="logic_boolean">
         *              <field name="BOOL">TRUE</field>
         *          </shadow>
         *     </value>
         * </block>
         */
        function mkPredicateBlock(type) {
            const block = document.createElement("block");
            block.setAttribute("type", type);
            const value = document.createElement("value");
            value.setAttribute("name", "PREDICATE");
            block.appendChild(value);
            const shadow = mkFieldBlock("logic_boolean", "BOOL", "TRUE", true);
            value.appendChild(shadow);
            return block;
        }
        blocks_4.mkPredicateBlock = mkPredicateBlock;
        function mkFieldBlock(type, fieldName, fieldValue, isShadow) {
            const fieldBlock = document.createElement(isShadow ? "shadow" : "block");
            fieldBlock.setAttribute("type", pxt.Util.htmlEscape(type));
            const field = document.createElement("field");
            field.setAttribute("name", pxt.Util.htmlEscape(fieldName));
            field.textContent = pxt.Util.htmlEscape(fieldValue);
            fieldBlock.appendChild(field);
            return fieldBlock;
        }
        blocks_4.mkFieldBlock = mkFieldBlock;
        function mkReturnStatementBlock() {
            const block = document.createElement("block");
            block.setAttribute("type", "function_return");
            const value = document.createElement("value");
            value.setAttribute("name", "RETURN_VALUE");
            block.appendChild(value);
            const shadow = mkFieldBlock("math_number", "NUM", "0", true);
            value.appendChild(shadow);
            return block;
        }
        blocks_4.mkReturnStatementBlock = mkReturnStatementBlock;
        let jresIconCache = {};
        function iconToFieldImage(id) {
            let url = jresIconCache[id];
            if (!url) {
                pxt.log(`missing jres icon ${id}`);
                return undefined;
            }
            return new Blockly.FieldImage(url, 40, 40, '', null, pxt.Util.isUserLanguageRtl());
        }
        function initJresIcons(blockInfo) {
            jresIconCache = {}; // clear previous cache
            const jres = blockInfo.apis.jres;
            if (!jres)
                return;
            Object.keys(jres).forEach((jresId) => {
                const jresObject = jres[jresId];
                if (jresObject && jresObject.icon)
                    jresIconCache[jresId] = jresObject.icon;
            });
        }
        function splitInputs(def) {
            const res = [];
            let current = [];
            def.parts.forEach(part => {
                switch (part.kind) {
                    case "break":
                        newInput();
                        break;
                    case "param":
                        current.push(part);
                        newInput();
                        break;
                    case "image":
                    case "label":
                        current.push(part);
                        break;
                }
            });
            newInput();
            return res;
            function newInput() {
                if (current.length) {
                    res.push(current);
                    current = [];
                }
            }
        }
        function namedField(field, name) {
            return { field, name };
        }
        function getEnumDropdownValues(apis, enumName) {
            return pxt.Util.values(apis.byQName).filter(sym => sym.namespace === enumName && !sym.attributes.blockHidden);
        }
        function getFixedInstanceDropdownValues(apis, qName) {
            const symbols = pxt.Util.values(apis.byQName).filter(sym => sym.kind === 4 /* Variable */
                && sym.attributes.fixedInstance
                && isSubtype(apis, sym.retType, qName))
                .sort((l, r) => (r.attributes.weight || 50) - (l.attributes.weight || 50));
            return symbols;
        }
        blocks_4.getFixedInstanceDropdownValues = getFixedInstanceDropdownValues;
        function generateIcons(instanceSymbols) {
            const imgConv = new pxt.ImageConverter();
            instanceSymbols.forEach(v => {
                if (v.attributes.jresURL && !v.attributes.iconURL && pxt.U.startsWith(v.attributes.jresURL, "data:image/x-mkcd-f")) {
                    v.attributes.iconURL = imgConv.convert(v.attributes.jresURL);
                }
            });
        }
        blocks_4.generateIcons = generateIcons;
        function getConstantDropdownValues(apis, qName) {
            return pxt.Util.values(apis.byQName).filter(sym => sym.attributes.blockIdentity === qName);
        }
        // Trims off a single space from beginning and end (if present)
        function removeOuterSpace(str) {
            if (str === " ") {
                return "";
            }
            else if (str.length > 1) {
                const startSpace = str.charAt(0) == " ";
                const endSpace = str.charAt(str.length - 1) == " ";
                if (startSpace || endSpace) {
                    return str.substring(startSpace ? 1 : 0, endSpace ? str.length - 1 : str.length);
                }
            }
            return str;
        }
        /**
         * Blockly variable fields can't be set directly; you either have to use the
         * variable ID or set the value of the model and not the field
         */
        function setVarFieldValue(block, fieldName, newName) {
            const varField = block.getField(fieldName);
            // Check for an existing model with this name; otherwise we'll create
            // a second variable with the same name and it will show up twice in the UI
            const vars = block.workspace.getAllVariables();
            let foundIt = false;
            if (vars && vars.length) {
                for (let v = 0; v < vars.length; v++) {
                    const model = vars[v];
                    if (model.name === newName) {
                        varField.setValue(model.getId());
                        foundIt = true;
                    }
                }
            }
            if (!foundIt) {
                varField.initModel();
                const model = varField.getVariable();
                model.name = newName;
                varField.setValue(model.getId());
            }
        }
        blocks_4.setVarFieldValue = setVarFieldValue;
        function getBlockData(block) {
            if (!block.data) {
                return {
                    commentRefs: [],
                    fieldData: {}
                };
            }
            if (/^(?:\d+;?)+$/.test(block.data)) {
                return {
                    commentRefs: block.data.split(";"),
                    fieldData: {}
                };
            }
            return JSON.parse(block.data);
        }
        blocks_4.getBlockData = getBlockData;
        function setBlockData(block, data) {
            block.data = JSON.stringify(data);
        }
        blocks_4.setBlockData = setBlockData;
        function setBlockDataForField(block, field, data) {
            const blockData = getBlockData(block);
            blockData.fieldData[field] = data;
            setBlockData(block, blockData);
        }
        blocks_4.setBlockDataForField = setBlockDataForField;
        function getBlockDataForField(block, field) {
            return getBlockData(block).fieldData[field];
        }
        blocks_4.getBlockDataForField = getBlockDataForField;
        class PxtWorkspaceSearch extends WorkspaceSearch {
            createDom_() {
                super.createDom_();
                this.addEvent_(this.workspace_.getInjectionDiv(), "click", this, (e) => {
                    if (this.htmlDiv_.style.display == "flex" && !this.htmlDiv_.contains(e.target)) {
                        this.close();
                    }
                });
            }
            highlightSearchGroup_(blocks) {
                blocks.forEach((block) => {
                    const blockPath = block.pathObject.svgPath;
                    Blockly.utils.dom.addClass(blockPath, 'blockly-ws-search-highlight-pxt');
                });
            }
            unhighlightSearchGroup_(blocks) {
                blocks.forEach((block) => {
                    const blockPath = block.pathObject.svgPath;
                    Blockly.utils.dom.removeClass(blockPath, 'blockly-ws-search-highlight-pxt');
                });
            }
            /**
             * https://github.com/google/blockly-samples/blob/master/plugins/workspace-search/src/WorkspaceSearch.js#L633
             *
             * Modified to center offscreen blocks.
             */
            scrollToVisible_(block) {
                if (!this.workspace_.isMovable()) {
                    // Cannot scroll to block in a non-movable workspace.
                    return;
                }
                // XY is in workspace coordinates.
                const xy = block.getRelativeToSurfaceXY();
                const scale = this.workspace_.scale;
                // Block bounds in pixels relative to the workspace origin (0,0 is centre).
                const width = block.width * scale;
                const height = block.height * scale;
                const top = xy.y * scale;
                const bottom = (xy.y + block.height) * scale;
                // In RTL the block's position is the top right of the block, not top left.
                const left = this.workspace_.RTL ? xy.x * scale - width : xy.x * scale;
                const right = this.workspace_.RTL ? xy.x * scale : xy.x * scale + width;
                const metrics = this.workspace_.getMetrics();
                let targetLeft = metrics.viewLeft;
                const overflowLeft = left < metrics.viewLeft;
                const overflowRight = right > metrics.viewLeft + metrics.viewWidth;
                const wideBlock = width > metrics.viewWidth;
                if ((!wideBlock && overflowLeft) || (wideBlock && !this.workspace_.RTL)) {
                    // Scroll to show left side of block
                    targetLeft = left;
                }
                else if ((!wideBlock && overflowRight) ||
                    (wideBlock && this.workspace_.RTL)) {
                    // Scroll to show right side of block
                    targetLeft = right - metrics.viewWidth;
                }
                let targetTop = metrics.viewTop;
                const overflowTop = top < metrics.viewTop;
                const overflowBottom = bottom > metrics.viewTop + metrics.viewHeight;
                const tallBlock = height > metrics.viewHeight;
                if (overflowTop || (tallBlock && overflowBottom)) {
                    // Scroll to show top of block
                    targetTop = top;
                }
                else if (overflowBottom) {
                    // Scroll to show bottom of block
                    targetTop = bottom - metrics.viewHeight;
                }
                if (targetLeft !== metrics.viewLeft || targetTop !== metrics.viewTop) {
                    const activeEl = document.activeElement;
                    if (wideBlock || tallBlock) {
                        this.workspace_.scroll(-targetLeft, -targetTop);
                    }
                    else {
                        this.workspace_.centerOnBlock(block.id);
                    }
                    if (activeEl) {
                        // Blockly.WidgetDiv.hide called in scroll is taking away focus.
                        // TODO: Review setFocused call in Blockly.WidgetDiv.hide.
                        activeEl.focus();
                    }
                }
            }
            open() {
                super.open();
                this.inputElement_.select();
                Blockly.utils.dom.addClass(this.workspace_.getInjectionDiv(), 'blockly-ws-searching');
            }
            close() {
                super.close();
                Blockly.utils.dom.removeClass(this.workspace_.getInjectionDiv(), 'blockly-ws-searching');
            }
        }
        blocks_4.PxtWorkspaceSearch = PxtWorkspaceSearch;
    })(blocks = pxt.blocks || (pxt.blocks = {}));
})(pxt || (pxt = {}));
var pxt;
(function (pxt) {
    var blocks;
    (function (blocks) {
        let MutatorTypes;
        (function (MutatorTypes) {
            MutatorTypes.ObjectDestructuringMutator = "objectdestructuring";
            MutatorTypes.RestParameterMutator = "restparameter";
            MutatorTypes.DefaultInstanceMutator = "defaultinstance";
        })(MutatorTypes = blocks.MutatorTypes || (blocks.MutatorTypes = {}));
        function addMutation(b, info, mutationType) {
            let m;
            switch (mutationType) {
                case MutatorTypes.ObjectDestructuringMutator:
                    if (!info.parameters || info.parameters.length < 1) {
                        console.error("Destructuring mutations require at least one parameter");
                    }
                    else {
                        let found = false;
                        for (const param of info.parameters) {
                            if (param.type.indexOf("=>") !== -1) {
                                if (!param.properties || param.properties.length === 0) {
                                    console.error("Destructuring mutations only supported for functions with an event parameter that has multiple properties");
                                    return;
                                }
                                found = true;
                            }
                        }
                        if (!found) {
                            console.error("Destructuring mutations must have an event parameter");
                            return;
                        }
                    }
                    m = new DestructuringMutator(b, info);
                    break;
                case MutatorTypes.RestParameterMutator:
                    m = new ArrayMutator(b, info);
                    break;
                case MutatorTypes.DefaultInstanceMutator:
                    m = new DefaultInstanceMutator(b, info);
                    break;
                default:
                    console.warn("Ignoring unknown mutation type: " + mutationType);
                    return;
            }
            b.mutationToDom = m.mutationToDom.bind(m);
            b.domToMutation = m.domToMutation.bind(m);
            b.compose = m.compose.bind(m);
            b.decompose = m.decompose.bind(m);
            b.mutation = m;
        }
        blocks.addMutation = addMutation;
        function mutateToolboxBlock(block, mutationType, mutation) {
            const mutationElement = document.createElement("mutation");
            switch (mutationType) {
                case MutatorTypes.ObjectDestructuringMutator:
                    mutationElement.setAttribute(DestructuringMutator.propertiesAttributeName, mutation);
                    break;
                case MutatorTypes.RestParameterMutator:
                    mutationElement.setAttribute(ArrayMutator.countAttributeName, mutation);
                    break;
                case MutatorTypes.DefaultInstanceMutator:
                    mutationElement.setAttribute(DefaultInstanceMutator.attributeName, mutation);
                default:
                    console.warn("Ignoring unknown mutation type: " + mutationType);
                    return;
            }
            block.appendChild(mutationElement);
        }
        blocks.mutateToolboxBlock = mutateToolboxBlock;
        class MutatorHelper {
            constructor(b, info) {
                this.info = info;
                this.block = b;
                this.topBlockType = this.block.type + "_mutator";
                const subBlocks = this.getSubBlockNames();
                this.initializeMutatorTopBlock();
                this.initializeMutatorSubBlocks(subBlocks);
                const mutatorToolboxTypes = subBlocks.map(s => s.type);
                this.block.setMutator(new Blockly.Mutator(mutatorToolboxTypes));
            }
            // Should be set to modify a block after a mutator dialog is updated
            compose(topBlock) {
                const allBlocks = topBlock.getDescendants(false).map(subBlock => {
                    return {
                        type: subBlock.type,
                        name: subBlock.inputList[0].name
                    };
                });
                // Toss the top block
                allBlocks.shift();
                this.updateBlock(allBlocks);
            }
            // Should be set to initialize the workspace inside a mutator dialog and return the top block
            decompose(workspace) {
                // Initialize flyout workspace's top block and add sub-blocks based on visible parameters
                const topBlock = workspace.newBlock(this.topBlockType);
                topBlock.initSvg();
                for (const input of topBlock.inputList) {
                    if (input.name === MutatorHelper.mutatorStatmentInput) {
                        let currentConnection = input.connection;
                        this.getVisibleBlockTypes().forEach(sub => {
                            const subBlock = workspace.newBlock(sub);
                            subBlock.initSvg();
                            currentConnection.connect(subBlock.previousConnection);
                            currentConnection = subBlock.nextConnection;
                        });
                        break;
                    }
                }
                return topBlock;
            }
            compileMutation(e, comments) {
                return undefined;
            }
            getDeclaredVariables() {
                return undefined;
            }
            isDeclaredByMutation(varName) {
                return false;
            }
            initializeMutatorSubBlock(sub, parameter, colour) {
                sub.appendDummyInput(parameter)
                    .appendField(parameter);
                sub.setColour(colour);
                sub.setNextStatement(true);
                sub.setPreviousStatement(true);
            }
            initializeMutatorTopBlock() {
                const topBlockTitle = this.info.attributes.mutateText;
                const colour = this.block.getColour();
                Blockly.Blocks[this.topBlockType] = Blockly.Blocks[this.topBlockType] || {
                    init: function () {
                        const top = this;
                        top.appendDummyInput()
                            .appendField(topBlockTitle);
                        top.setColour(colour);
                        top.appendStatementInput(MutatorHelper.mutatorStatmentInput);
                    }
                };
            }
            initializeMutatorSubBlocks(subBlocks) {
                const colour = this.block.getColour();
                const initializer = this.initializeMutatorSubBlock.bind(this);
                subBlocks.forEach(blockName => {
                    Blockly.Blocks[blockName.type] = Blockly.Blocks[blockName.type] || {
                        init: function () { initializer(this, blockName.name, colour); }
                    };
                });
            }
        }
        MutatorHelper.mutatorStatmentInput = "PROPERTIES";
        MutatorHelper.mutatedVariableInputName = "properties";
        class DestructuringMutator extends MutatorHelper {
            constructor(b, info) {
                super(b, info);
                this.currentlyVisible = [];
                this.parameterRenames = {};
                this.prefix = this.info.attributes.mutatePrefix;
                this.block.appendDummyInput(MutatorHelper.mutatedVariableInputName);
                this.block.appendStatementInput("HANDLER")
                    .setCheck("null");
            }
            getMutationType() {
                return MutatorTypes.ObjectDestructuringMutator;
            }
            compileMutation(e, comments) {
                if (!this.info.attributes.mutatePropertyEnum && !this.parameters.length) {
                    return undefined;
                }
                const declarationString = this.parameters.map(param => {
                    const varField = this.block.getField(param);
                    const declaredName = varField && varField.getText();
                    const escapedParam = blocks.escapeVarName(param, e);
                    if (declaredName !== param) {
                        this.parameterRenames[param] = declaredName;
                        return `${param}: ${blocks.escapeVarName(declaredName, e)}`;
                    }
                    return escapedParam;
                }).join(", ");
                const functionString = `function ({ ${declarationString} })`;
                if (this.info.attributes.mutatePropertyEnum) {
                    return blocks.mkText(` [${this.parameters.map(p => `${this.info.attributes.mutatePropertyEnum}.${p}`).join(", ")}],${functionString}`);
                }
                else {
                    return blocks.mkText(functionString);
                }
            }
            getDeclaredVariables() {
                const result = {};
                this.parameters.forEach(param => {
                    result[this.getVarFieldValue(param)] = this.parameterTypes[param];
                });
                return result;
            }
            isDeclaredByMutation(varName) {
                return this.parameters.some(param => this.getVarFieldValue(param) === varName);
            }
            mutationToDom() {
                // Save the parameters that are currently visible to the DOM along with their names
                const mutation = document.createElement("mutation");
                const attr = this.parameters.map(param => {
                    const varName = this.getVarFieldValue(param);
                    if (varName !== param) {
                        this.parameterRenames[param] = pxt.Util.htmlEscape(varName);
                    }
                    return pxt.Util.htmlEscape(param);
                }).join(",");
                mutation.setAttribute(DestructuringMutator.propertiesAttributeName, attr);
                for (const parameter in this.parameterRenames) {
                    if (parameter === this.parameterRenames[parameter]) {
                        delete this.parameterRenames[parameter];
                    }
                }
                mutation.setAttribute(DestructuringMutator.renameAttributeName, JSON.stringify(this.parameterRenames));
                return mutation;
            }
            domToMutation(xmlElement) {
                // Restore visible parameters based on saved DOM
                const savedParameters = xmlElement.getAttribute(DestructuringMutator.propertiesAttributeName);
                if (savedParameters) {
                    const split = savedParameters.split(",");
                    const properties = [];
                    if (this.paramIndex === undefined) {
                        this.paramIndex = this.getParameterIndex();
                    }
                    split.forEach(saved => {
                        // Parse the old way of storing renames to maintain backwards compatibility
                        const parts = saved.split(":");
                        if (this.info.parameters[this.paramIndex].properties.some(p => p.name === parts[0])) {
                            properties.push({
                                property: parts[0],
                                newName: parts[1]
                            });
                        }
                    });
                    this.parameterRenames = undefined;
                    if (xmlElement.hasAttribute(DestructuringMutator.renameAttributeName)) {
                        try {
                            this.parameterRenames = JSON.parse(xmlElement.getAttribute(DestructuringMutator.renameAttributeName));
                        }
                        catch (e) {
                            console.warn("Ignoring invalid rename map in saved block mutation");
                        }
                    }
                    this.parameterRenames = this.parameterRenames || {};
                    // Create the fields for each property with default variable names
                    this.parameters = [];
                    properties.forEach(prop => {
                        this.parameters.push(prop.property);
                        if (prop.newName && prop.newName !== prop.property) {
                            this.parameterRenames[prop.property] = prop.newName;
                        }
                    });
                    this.updateVisibleProperties();
                    // Override any names that the user has changed
                    properties.filter(p => !!p.newName).forEach(p => this.setVarFieldValue(p.property, p.newName));
                }
            }
            getVarFieldValue(fieldName) {
                const varField = this.block.getField(fieldName);
                return varField && varField.getText();
            }
            setVarFieldValue(fieldName, newValue) {
                const varField = this.block.getField(fieldName);
                if (this.block.getField(fieldName)) {
                    blocks.setVarFieldValue(this.block, fieldName, newValue);
                }
            }
            updateBlock(subBlocks) {
                this.parameters = [];
                // Ignore duplicate blocks
                subBlocks.forEach(p => {
                    if (this.parameters.indexOf(p.name) === -1) {
                        this.parameters.push(p.name);
                    }
                });
                this.updateVisibleProperties();
            }
            getSubBlockNames() {
                this.parameters = [];
                this.parameterTypes = {};
                if (this.paramIndex === undefined) {
                    this.paramIndex = this.getParameterIndex();
                }
                return this.info.parameters[this.paramIndex].properties.map(property => {
                    // Used when compiling the destructured arguments
                    this.parameterTypes[property.name] = property.type;
                    return {
                        type: this.propertyId(property.name),
                        name: property.name
                    };
                });
            }
            getVisibleBlockTypes() {
                return this.currentlyVisible.map(p => this.propertyId(p));
            }
            updateVisibleProperties() {
                if (pxt.Util.listsEqual(this.currentlyVisible, this.parameters)) {
                    return;
                }
                const dummyInput = this.block.inputList.find(i => i.name === MutatorHelper.mutatedVariableInputName);
                if (this.prefix && this.currentlyVisible.length === 0) {
                    dummyInput.appendField(this.prefix, DestructuringMutator.prefixLabel);
                }
                this.currentlyVisible.forEach(param => {
                    if (this.parameters.indexOf(param) === -1) {
                        const name = this.getVarFieldValue(param);
                        // Persist renames
                        if (name !== param) {
                            this.parameterRenames[param] = name;
                        }
                        dummyInput.removeField(param);
                    }
                });
                this.parameters.forEach(param => {
                    if (this.currentlyVisible.indexOf(param) === -1) {
                        const fieldValue = this.parameterRenames[param] || param;
                        dummyInput.appendField(new Blockly.FieldVariable(fieldValue), param);
                    }
                });
                if (this.prefix && this.parameters.length === 0) {
                    dummyInput.removeField(DestructuringMutator.prefixLabel);
                }
                this.currentlyVisible = this.parameters;
            }
            propertyId(property) {
                return this.block.type + "_" + property;
            }
            getParameterIndex() {
                for (let i = 0; i < this.info.parameters.length; i++) {
                    if (this.info.parameters[i].type.indexOf("=>") !== -1) {
                        return i;
                    }
                }
                return undefined;
            }
        }
        DestructuringMutator.propertiesAttributeName = "callbackproperties";
        DestructuringMutator.renameAttributeName = "renamemap";
        // Avoid clashes by starting labels with a number
        DestructuringMutator.prefixLabel = "0prefix_label_";
        class ArrayMutator extends MutatorHelper {
            constructor() {
                super(...arguments);
                this.count = 0;
            }
            getMutationType() {
                return MutatorTypes.RestParameterMutator;
            }
            compileMutation(e, comments) {
                const values = [];
                this.forEachInput(block => values.push(blocks.compileExpression(e, block, comments)));
                return blocks.mkGroup(values);
            }
            mutationToDom() {
                const mutation = document.createElement("mutation");
                mutation.setAttribute(ArrayMutator.countAttributeName, this.count.toString());
                return mutation;
            }
            domToMutation(xmlElement) {
                const attribute = xmlElement.getAttribute(ArrayMutator.countAttributeName);
                if (attribute) {
                    try {
                        this.count = parseInt(attribute);
                    }
                    catch (e) {
                        return;
                    }
                    for (let i = 0; i < this.count; i++) {
                        this.addNumberField(false, i);
                    }
                }
            }
            updateBlock(subBlocks) {
                if (subBlocks) {
                    const diff = Math.abs(this.count - subBlocks.length);
                    if (this.count < subBlocks.length) {
                        for (let i = 0; i < diff; i++)
                            this.addNumberField(true, this.count);
                    }
                    else if (this.count > subBlocks.length) {
                        for (let i = 0; i < diff; i++)
                            this.removeNumberField();
                    }
                }
            }
            getSubBlockNames() {
                return [{
                        name: "Value",
                        type: ArrayMutator.entryTypeName
                    }];
            }
            getVisibleBlockTypes() {
                const result = [];
                this.forEachInput(() => result.push(ArrayMutator.entryTypeName));
                return result;
            }
            addNumberField(isNewField, index) {
                const input = this.block.appendValueInput(ArrayMutator.valueInputPrefix + index).setCheck("Number");
                if (isNewField) {
                    const valueBlock = this.block.workspace.newBlock("math_number");
                    valueBlock.initSvg();
                    valueBlock.setShadow(true);
                    input.connection.connect(valueBlock.outputConnection);
                    this.block.workspace.render();
                    this.count++;
                }
            }
            removeNumberField() {
                if (this.count > 0) {
                    this.block.removeInput(ArrayMutator.valueInputPrefix + (this.count - 1));
                }
                this.count--;
            }
            forEachInput(cb) {
                for (let i = 0; i < this.count; i++) {
                    cb(this.block.getInputTargetBlock(ArrayMutator.valueInputPrefix + i), i);
                }
            }
        }
        ArrayMutator.countAttributeName = "count";
        ArrayMutator.entryTypeName = "entry";
        ArrayMutator.valueInputPrefix = "value_input_";
        class DefaultInstanceMutator extends MutatorHelper {
            constructor() {
                super(...arguments);
                this.showing = false;
            }
            getMutationType() {
                return MutatorTypes.DefaultInstanceMutator;
            }
            compileMutation(e, comments) {
                if (this.showing) {
                    const target = this.block.getInputTargetBlock(DefaultInstanceMutator.instanceInputName);
                    if (target) {
                        return blocks.compileExpression(e, target, comments);
                    }
                }
                return undefined;
            }
            mutationToDom() {
                const mutation = document.createElement("mutation");
                mutation.setAttribute(DefaultInstanceMutator.attributeName, this.showing ? "true" : "false");
                return mutation;
            }
            domToMutation(xmlElement) {
                const attribute = xmlElement.getAttribute(DefaultInstanceMutator.attributeName);
                if (attribute) {
                    this.updateShape(attribute === "true");
                }
                else {
                    this.updateShape(false);
                }
            }
            updateBlock(subBlocks) {
                this.updateShape(!!(subBlocks && subBlocks.length));
            }
            getSubBlockNames() {
                return [{
                        name: "Instance",
                        type: DefaultInstanceMutator.instanceSubBlockType
                    }];
            }
            getVisibleBlockTypes() {
                const result = [];
                if (this.showing) {
                    result.push(DefaultInstanceMutator.instanceSubBlockType);
                }
                return result;
            }
            updateShape(show) {
                if (this.showing !== show) {
                    if (show && !this.block.getInputTargetBlock(DefaultInstanceMutator.instanceInputName)) {
                        this.block.appendValueInput(DefaultInstanceMutator.instanceInputName);
                    }
                    else {
                        this.block.removeInput(DefaultInstanceMutator.instanceInputName);
                    }
                    this.showing = show;
                }
            }
        }
        DefaultInstanceMutator.attributeName = "showing";
        DefaultInstanceMutator.instanceInputName = "__instance__";
        DefaultInstanceMutator.instanceSubBlockType = "instance";
    })(blocks = pxt.blocks || (pxt.blocks = {}));
})(pxt || (pxt = {}));
/// <reference path="../localtypings/pxtblockly.d.ts" />
/// <reference path="../built/pxtlib.d.ts" />
var pxt;
(function (pxt) {
    var blocks;
    (function (blocks_5) {
        let workspace;
        let blocklyDiv;
        let BlockLayout;
        (function (BlockLayout) {
            BlockLayout[BlockLayout["None"] = 0] = "None";
            BlockLayout[BlockLayout["Align"] = 1] = "Align";
            // Shuffle deprecated
            BlockLayout[BlockLayout["Clean"] = 3] = "Clean";
            BlockLayout[BlockLayout["Flow"] = 4] = "Flow";
        })(BlockLayout = blocks_5.BlockLayout || (blocks_5.BlockLayout = {}));
        function initRenderingWorkspace() {
            if (!workspace) {
                blocklyDiv = document.createElement("div");
                blocklyDiv.style.position = "absolute";
                blocklyDiv.style.top = "0";
                blocklyDiv.style.left = "0";
                blocklyDiv.style.width = "1px";
                blocklyDiv.style.height = "1px";
                document.body.appendChild(blocklyDiv);
                workspace = Blockly.inject(blocklyDiv, {
                    move: {
                        scrollbars: false
                    },
                    readOnly: true,
                    sounds: false,
                    media: pxt.webConfig.commitCdnUrl + "blockly/media/",
                    rtl: pxt.Util.isUserLanguageRtl(),
                    renderer: "pxt"
                });
            }
            pxt.blocks.clearWithoutEvents(workspace);
            return workspace;
        }
        blocks_5.initRenderingWorkspace = initRenderingWorkspace;
        function cleanRenderingWorkspace() {
            // We re-use the workspace across renders, catch any errors so we know to
            // create a new workspace if there was an error
            if (workspace)
                workspace.dispose();
            workspace = undefined;
        }
        blocks_5.cleanRenderingWorkspace = cleanRenderingWorkspace;
        function renderWorkspace(options = { emPixels: 18, layout: BlockLayout.Align }) {
            const layout = options.splitSvg ? BlockLayout.Align : (options.layout || BlockLayout.Flow);
            switch (layout) {
                case BlockLayout.Align:
                    pxt.blocks.layout.verticalAlign(workspace, options.emPixels || 18);
                    break;
                case BlockLayout.Flow:
                    pxt.blocks.layout.flow(workspace, { ratio: options.aspectRatio, useViewWidth: options.useViewWidth });
                    break;
                case BlockLayout.Clean:
                    if (workspace.cleanUp_)
                        workspace.cleanUp_();
                    break;
                default: // do nothing
                    break;
            }
            let metrics = workspace.getMetrics();
            const svg = blocklyDiv.querySelectorAll('svg')[0].cloneNode(true);
            pxt.blocks.layout.cleanUpBlocklySvg(svg);
            pxt.U.toArray(svg.querySelectorAll('.blocklyBlockCanvas,.blocklyBubbleCanvas'))
                .forEach(el => el.setAttribute('transform', `translate(${-metrics.contentLeft}, ${-metrics.contentTop}) scale(1)`));
            svg.setAttribute('viewBox', `0 0 ${metrics.contentWidth} ${metrics.contentHeight}`);
            if (options.emPixels) {
                svg.style.width = (metrics.contentWidth / options.emPixels) + 'em';
                svg.style.height = (metrics.contentHeight / options.emPixels) + 'em';
            }
            return options.splitSvg
                ? pxt.blocks.layout.splitSvg(svg, workspace, options.emPixels)
                : svg;
        }
        blocks_5.renderWorkspace = renderWorkspace;
        function render(blocksXml, options = { emPixels: 18, layout: BlockLayout.Align }) {
            initRenderingWorkspace();
            try {
                let text = blocksXml || `<xml xmlns="http://www.w3.org/1999/xhtml"></xml>`;
                let xml = Blockly.Xml.textToDom(text);
                pxt.blocks.domToWorkspaceNoEvents(xml, workspace);
                return renderWorkspace(options);
            }
            catch (e) {
                pxt.reportException(e);
                return undefined;
            }
            finally {
                cleanRenderingWorkspace();
            }
        }
        blocks_5.render = render;
        function blocksMetrics(ws) {
            const blocks = ws.getTopBlocks(false);
            if (!blocks.length)
                return { width: 0, height: 0 };
            let m = undefined;
            blocks.forEach((b) => {
                const r = b.getBoundingRectangle();
                if (!m)
                    m = { l: r.left, r: r.right, t: r.top, b: r.bottom };
                else {
                    m.l = Math.min(m.l, r.left);
                    m.r = Math.max(m.r, r.right);
                    m.t = Math.min(m.t, r.top);
                    m.b = Math.min(m.b, r.bottom);
                }
            });
            return {
                width: m.r - m.l,
                height: m.b - m.t
            };
        }
        blocks_5.blocksMetrics = blocksMetrics;
    })(blocks = pxt.blocks || (pxt.blocks = {}));
})(pxt || (pxt = {}));
/// <reference path="../localtypings/blockly.d.ts" />
/// <reference path="../built/pxtlib.d.ts" />
var pxt;
(function (pxt) {
    var blocks;
    (function (blocks_6) {
        function findRootBlocks(xmlDOM, type) {
            let blocks = [];
            for (const child in xmlDOM.children) {
                const xmlChild = xmlDOM.children[child];
                if (xmlChild.tagName === 'block') {
                    if (type) {
                        const childType = xmlChild.getAttribute('type');
                        if (childType && childType === type) {
                            blocks.push(xmlChild);
                        }
                    }
                    else {
                        blocks.push(xmlChild);
                    }
                }
                else {
                    const childChildren = findRootBlock(xmlChild);
                    if (childChildren) {
                        blocks = blocks.concat(childChildren);
                    }
                }
            }
            return blocks;
        }
        blocks_6.findRootBlocks = findRootBlocks;
        function findRootBlock(xmlDOM, type) {
            let blks = findRootBlocks(xmlDOM, type);
            if (blks.length)
                return blks[0];
            return null;
        }
        blocks_6.findRootBlock = findRootBlock;
    })(blocks = pxt.blocks || (pxt.blocks = {}));
})(pxt || (pxt = {}));
var pxt;
(function (pxt) {
    var docs;
    (function (docs) {
        var codeCard;
        (function (codeCard) {
            function render(card, options = {}) {
                const url = card.url ? /^[^:]+:\/\//.test(card.url) ? card.url : ('/' + card.url.replace(/^\.?\/?/, ''))
                    : card.youTubeId ? `https://youtu.be/${card.youTubeId}` : undefined;
                const link = !!url;
                const div = (parent, cls, tag = "div", text = '') => {
                    let d = document.createElement(tag);
                    if (cls)
                        d.className = cls;
                    if (parent)
                        parent.appendChild(d);
                    if (text)
                        d.appendChild(document.createTextNode(text + ''));
                    return d;
                };
                const style = card.style || "card";
                let r = div(null, 'ui ' + style + ' ' + (card.color || '') + (link ? ' link' : ''), link ? "a" : "div");
                r.setAttribute("role", "option");
                r.setAttribute("aria-selected", "true");
                if (link) {
                    const rAsLink = r;
                    rAsLink.href = url;
                    // pop out external links
                    if (/^https?:\/\//.test(url)) {
                        rAsLink.target = "_blank";
                    }
                }
                if (!options.hideHeader && card.header) {
                    let h = div(r, "ui content " + (card.responsive ? " tall desktop only" : ""));
                    if (card.header)
                        div(h, 'description', 'span', card.header);
                }
                const name = (options.shortName ? card.shortName : '') || card.name;
                let img = div(r, "ui image" + (card.responsive ? " tall landscape only" : ""));
                if (card.label) {
                    let lbl = document.createElement("label");
                    lbl.className = `ui ${card.labelClass ? card.labelClass : "orange right ribbon"} label`;
                    lbl.textContent = card.label;
                    img.appendChild(lbl);
                }
                if (card.blocksXml) {
                    const svg = pxt.blocks.render(card.blocksXml);
                    if (!svg) {
                        console.error("failed to render blocks");
                        pxt.debug(card.blocksXml);
                    }
                    else {
                        let holder = div(img, '');
                        holder.setAttribute('style', 'width:100%; min-height:10em');
                        holder.appendChild(svg);
                    }
                }
                if (card.typeScript) {
                    let pre = document.createElement("pre");
                    pre.appendChild(document.createTextNode(card.typeScript));
                    img.appendChild(pre);
                }
                const imgUrl = card.imageUrl || (card.youTubeId ? `https://img.youtube.com/vi/${card.youTubeId}/0.jpg` : undefined);
                if (imgUrl) {
                    let imageWrapper = document.createElement("div");
                    imageWrapper.className = "ui imagewrapper";
                    let image = document.createElement("div");
                    image.className = "ui cardimage";
                    image.style.backgroundImage = `url("${card.imageUrl}")`;
                    image.title = name;
                    image.setAttribute("role", "presentation");
                    imageWrapper.appendChild(image);
                    img.appendChild(imageWrapper);
                }
                if (card.cardType == "file") {
                    let file = div(r, "ui fileimage");
                    img.appendChild(file);
                }
                if (name || card.description) {
                    let ct = div(r, "ui content");
                    if (name) {
                        r.setAttribute("aria-label", name);
                        div(ct, 'header', 'div', name);
                    }
                    if (card.description) {
                        const descr = div(ct, 'ui description');
                        const shortenedDescription = card.description.split('.')[0] + '.';
                        descr.appendChild(document.createTextNode(shortenedDescription));
                    }
                }
                if (card.time) {
                    let meta = div(r, "meta");
                    if (card.time) {
                        let m = div(meta, "date", "span");
                        m.appendChild(document.createTextNode(pxt.Util.timeSince(card.time)));
                    }
                }
                if (card.extracontent) {
                    let extracontent = div(r, "extra content", "div");
                    extracontent.appendChild(document.createTextNode(card.extracontent));
                }
                return r;
            }
            codeCard.render = render;
        })(codeCard = docs.codeCard || (docs.codeCard = {}));
    })(docs = pxt.docs || (pxt.docs = {}));
})(pxt || (pxt = {}));
/// <reference path="../localtypings/blockly.d.ts" />
var pxt;
(function (pxt) {
    var blocks;
    (function (blocks) {
        function appendMutation(block, mutation) {
            const b = block;
            const oldMTD = b.mutationToDom;
            const oldDTM = b.domToMutation;
            b.mutationToDom = () => {
                const el = oldMTD ? oldMTD() : document.createElement("mutation");
                return mutation.mutationToDom(el);
            };
            b.domToMutation = saved => {
                if (oldDTM) {
                    oldDTM(saved);
                }
                mutation.domToMutation(saved);
            };
        }
        blocks.appendMutation = appendMutation;
        function initVariableArgsBlock(b, handlerArgs) {
            let currentlyVisible = 0;
            let actuallyVisible = 0;
            let i = b.appendDummyInput();
            let updateShape = () => {
                if (currentlyVisible === actuallyVisible) {
                    return;
                }
                if (currentlyVisible > actuallyVisible) {
                    const diff = currentlyVisible - actuallyVisible;
                    for (let j = 0; j < diff; j++) {
                        const arg = handlerArgs[actuallyVisible + j];
                        i.insertFieldAt(i.fieldRow.length - 1, new pxtblockly.FieldArgumentVariable(arg.name), "HANDLER_" + arg.name);
                        const blockSvg = b;
                        if (blockSvg === null || blockSvg === void 0 ? void 0 : blockSvg.initSvg)
                            blockSvg.initSvg(); // call initSvg on block to initialize new fields
                    }
                }
                else {
                    let diff = actuallyVisible - currentlyVisible;
                    for (let j = 0; j < diff; j++) {
                        const arg = handlerArgs[actuallyVisible - j - 1];
                        i.removeField("HANDLER_" + arg.name);
                    }
                }
                if (currentlyVisible >= handlerArgs.length) {
                    i.removeField("_HANDLER_ADD");
                }
                else if (actuallyVisible >= handlerArgs.length) {
                    addPlusButton();
                }
                actuallyVisible = currentlyVisible;
            };
            Blockly.Extensions.apply('inline-svgs', b, false);
            addPlusButton();
            appendMutation(b, {
                mutationToDom: (el) => {
                    el.setAttribute("numArgs", currentlyVisible.toString());
                    for (let j = 0; j < currentlyVisible; j++) {
                        const varField = b.getField("HANDLER_" + handlerArgs[j].name);
                        let varName = varField && varField.getText();
                        el.setAttribute("arg" + j, varName);
                    }
                    return el;
                },
                domToMutation: (saved) => {
                    let numArgs = parseInt(saved.getAttribute("numargs"));
                    currentlyVisible = Math.min(isNaN(numArgs) ? 0 : numArgs, handlerArgs.length);
                    updateShape();
                    for (let j = 0; j < currentlyVisible; j++) {
                        const varName = saved.getAttribute("arg" + j);
                        const fieldName = "HANDLER_" + handlerArgs[j].name;
                        if (b.getField(fieldName)) {
                            blocks.setVarFieldValue(b, fieldName, varName);
                        }
                    }
                }
            });
            function addPlusButton() {
                i.appendField(new Blockly.FieldImage(b.ADD_IMAGE_DATAURI, 24, 24, lf("Add argument"), () => {
                    currentlyVisible = Math.min(currentlyVisible + 1, handlerArgs.length);
                    updateShape();
                }, false), "_HANDLER_ADD");
            }
        }
        blocks.initVariableArgsBlock = initVariableArgsBlock;
        function initExpandableBlock(info, b, def, comp, toggle, addInputs) {
            // Add numbers before input names to prevent clashes with the ones added
            // by BlocklyLoader. The number makes it an invalid JS identifier
            const buttonAddName = "0_add_button";
            const buttonRemName = "0_rem_button";
            const buttonAddRemName = "0_add_rem_button";
            const numVisibleAttr = "_expanded";
            const inputInitAttr = "_input_init";
            const optionNames = def.parameters.map(p => p.name);
            const totalOptions = def.parameters.length;
            const buttonDelta = toggle ? totalOptions : 1;
            const variableInlineInputs = info.blocksById[b.type].attributes.inlineInputMode === "variable";
            const inlineInputModeLimit = info.blocksById[b.type].attributes.inlineInputModeLimit || 4;
            const compileHiddenArguments = info.blocksById[b.type].attributes.compileHiddenArguments;
            const breakString = info.blocksById[b.type].attributes.expandableArgumentBreaks;
            let breaks;
            if (breakString) {
                breaks = breakString.split(/[;,]/).map(s => parseInt(s));
            }
            const state = new MutationState(b);
            state.setEventsEnabled(false);
            state.setValue(numVisibleAttr, 0);
            state.setValue(inputInitAttr, false);
            state.setEventsEnabled(true);
            Blockly.Extensions.apply('inline-svgs', b, false);
            let updatingInputs = false;
            let firstRender = true;
            appendMutation(b, {
                mutationToDom: (el) => {
                    // The reason we store the inputsInitialized variable separately from visibleOptions
                    // is because it's possible for the block to get into a state where all inputs are
                    // initialized but they aren't visible (i.e. the user hit the - button). Blockly
                    // gets upset if a block has a different number of inputs when it is saved and restored.
                    el.setAttribute(numVisibleAttr, state.getString(numVisibleAttr));
                    el.setAttribute(inputInitAttr, state.getString(inputInitAttr));
                    return el;
                },
                domToMutation: (saved) => {
                    state.setEventsEnabled(false);
                    if (saved.hasAttribute(inputInitAttr) && saved.getAttribute(inputInitAttr) == "true" && !state.getBoolean(inputInitAttr)) {
                        state.setValue(inputInitAttr, true);
                    }
                    initOptionalInputs();
                    if (saved.hasAttribute(numVisibleAttr)) {
                        const val = parseInt(saved.getAttribute(numVisibleAttr));
                        if (!isNaN(val)) {
                            const delta = val - (state.getNumber(numVisibleAttr) || 0);
                            if (state.getBoolean(inputInitAttr)) {
                                if (b.rendered || b.isInsertionMarker()) {
                                    updateShape(delta, true, b.isInsertionMarker());
                                }
                                else {
                                    state.setValue(numVisibleAttr, addDelta(delta));
                                    updateButtons();
                                }
                            }
                            else {
                                updateShape(delta, true);
                            }
                        }
                    }
                    state.setEventsEnabled(true);
                }
            });
            initOptionalInputs();
            if (compileHiddenArguments) {
                // Make sure all inputs have shadow blocks attached
                let optIndex = 0;
                for (let i = 0; i < b.inputList.length; i++) {
                    const input = b.inputList[i];
                    if (pxt.Util.startsWith(input.name, blocks.optionalInputWithFieldPrefix) || optionNames.indexOf(input.name) !== -1) {
                        if (input.connection && !input.connection.isConnected() && !b.isInsertionMarker()) {
                            const param = comp.definitionNameToParam[def.parameters[optIndex].name];
                            attachShadowBlock(input, param);
                        }
                        ++optIndex;
                    }
                }
            }
            b.render = (opt_bubble) => {
                if (updatingInputs)
                    return;
                if (firstRender) {
                    firstRender = false;
                    updatingInputs = true;
                    updateShape(0, undefined, true);
                    updatingInputs = false;
                }
                Blockly.BlockSvg.prototype.render.call(b, opt_bubble);
            };
            // Set skipRender to true if the block is still initializing. Otherwise
            // the inputs will render before their shadow blocks are created and
            // leave behind annoying artifacts
            function updateShape(delta, skipRender = false, force = false) {
                const newValue = addDelta(delta);
                if (!force && !skipRender && newValue === state.getNumber(numVisibleAttr))
                    return;
                state.setValue(numVisibleAttr, newValue);
                const visibleOptions = newValue;
                if (!state.getBoolean(inputInitAttr) && visibleOptions > 0) {
                    initOptionalInputs();
                    if (!b.rendered) {
                        return;
                    }
                }
                let optIndex = 0;
                for (let i = 0; i < b.inputList.length; i++) {
                    const input = b.inputList[i];
                    if (pxt.Util.startsWith(input.name, blocks.optionalDummyInputPrefix)) {
                        // The behavior for dummy inputs (i.e. labels) is that whenever a parameter is revealed,
                        // all earlier labels are made visible as well. If the parameter is the last one in the
                        // block then all labels are made visible
                        setInputVisible(input, optIndex < visibleOptions || visibleOptions === totalOptions);
                    }
                    else if (pxt.Util.startsWith(input.name, blocks.optionalInputWithFieldPrefix) || optionNames.indexOf(input.name) !== -1) {
                        const visible = optIndex < visibleOptions;
                        setInputVisible(input, visible);
                        if (visible && input.connection && !input.connection.isConnected() && !b.isInsertionMarker()) {
                            const param = comp.definitionNameToParam[def.parameters[optIndex].name];
                            attachShadowBlock(input, param);
                        }
                        ++optIndex;
                    }
                }
                updateButtons();
                if (variableInlineInputs)
                    b.setInputsInline(visibleOptions < inlineInputModeLimit);
                if (!skipRender)
                    b.render();
            }
            function addButton(name, uri, alt, delta) {
                b.appendDummyInput(name)
                    .appendField(new Blockly.FieldImage(uri, 24, 24, alt, () => updateShape(delta), false));
            }
            function updateButtons() {
                if (updatingInputs)
                    return;
                const visibleOptions = state.getNumber(numVisibleAttr);
                const showPlus = visibleOptions !== totalOptions;
                const showMinus = visibleOptions !== 0;
                if (b.inputList.some(i => i.name === buttonAddName))
                    b.removeInput(buttonAddName, true);
                if (b.inputList.some(i => i.name === buttonRemName))
                    b.removeInput(buttonRemName, true);
                if (b.inputList.some(i => i.name === buttonAddRemName))
                    b.removeInput(buttonAddRemName, true);
                if (showPlus && showMinus) {
                    addPlusAndMinusButtons();
                }
                else if (showPlus) {
                    addPlusButton();
                }
                else if (showMinus) {
                    addMinusButton();
                }
            }
            function addPlusAndMinusButtons() {
                b.appendDummyInput(buttonAddRemName)
                    .appendField(new Blockly.FieldImage(b.REMOVE_IMAGE_DATAURI, 24, 24, lf("Hide optional arguments"), () => updateShape(-1 * buttonDelta), false))
                    .appendField(new Blockly.FieldImage(b.ADD_IMAGE_DATAURI, 24, 24, lf("Reveal optional arguments"), () => updateShape(buttonDelta), false));
            }
            function addPlusButton() {
                addButton(buttonAddName, b.ADD_IMAGE_DATAURI, lf("Reveal optional arguments"), buttonDelta);
            }
            function addMinusButton() {
                addButton(buttonRemName, b.REMOVE_IMAGE_DATAURI, lf("Hide optional arguments"), -1 * buttonDelta);
            }
            function initOptionalInputs() {
                state.setValue(inputInitAttr, true);
                addInputs();
                updateButtons();
            }
            function addDelta(delta) {
                const newValue = Math.min(Math.max(state.getNumber(numVisibleAttr) + delta, 0), totalOptions);
                if (breaks) {
                    if (delta >= 0) {
                        if (newValue === 0)
                            return 0;
                        for (const breakpoint of breaks) {
                            if (breakpoint >= newValue) {
                                return breakpoint;
                            }
                        }
                        return totalOptions;
                    }
                    else {
                        for (let i = 0; i < breaks.length; i++) {
                            if (breaks[i] >= newValue) {
                                return i > 0 ? breaks[i - 1] : 0;
                            }
                        }
                        return breaks[breaks.length - 1];
                    }
                }
                return newValue;
            }
            function setInputVisible(input, visible) {
                // If the block isn't rendered, Blockly will crash
                input.setVisible(visible);
            }
            function attachShadowBlock(input, param) {
                let shadow = blocks.createShadowValue(info, param);
                if (shadow.tagName.toLowerCase() === "value") {
                    // Unwrap the block
                    shadow = shadow.firstElementChild;
                }
                Blockly.Events.disable();
                try {
                    const nb = Blockly.Xml.domToBlock(shadow, b.workspace);
                    if (nb) {
                        input.connection.connect(nb.outputConnection);
                    }
                }
                catch (e) { }
                Blockly.Events.enable();
            }
        }
        blocks.initExpandableBlock = initExpandableBlock;
        function initReturnStatement(b) {
            const returnDef = pxt.blocks.getBlockDefinition("function_return");
            const buttonAddName = "0_add_button";
            const buttonRemName = "0_rem_button";
            Blockly.Extensions.apply('inline-svgs', b, false);
            let returnValueVisible = true;
            // When the value input is removed, we disconnect the block that was connected to it. This
            // is the id of whatever block was last connected
            let lastConnectedId;
            updateShape();
            b.domToMutation = saved => {
                if (saved.hasAttribute("last_connected_id")) {
                    lastConnectedId = saved.getAttribute("last_connected_id");
                }
                returnValueVisible = hasReturnValue(saved);
                updateShape();
            };
            b.mutationToDom = () => {
                const mutation = document.createElement("mutation");
                setReturnValue(mutation, !!b.getInput("RETURN_VALUE"));
                if (lastConnectedId) {
                    mutation.setAttribute("last_connected_id", lastConnectedId);
                }
                return mutation;
            };
            function updateShape() {
                const returnValueInput = b.getInput("RETURN_VALUE");
                if (returnValueVisible) {
                    if (!returnValueInput) {
                        // Remove any labels
                        while (b.getInput(""))
                            b.removeInput("");
                        b.jsonInit({
                            "message0": returnDef.block["message_with_value"],
                            "args0": [
                                {
                                    "type": "input_value",
                                    "name": "RETURN_VALUE",
                                    "check": null
                                }
                            ],
                            "previousStatement": null,
                            "colour": pxt.toolbox.getNamespaceColor('functions')
                        });
                    }
                    if (b.getInput(buttonAddName)) {
                        b.removeInput(buttonAddName);
                    }
                    if (!b.getInput(buttonRemName)) {
                        addMinusButton();
                    }
                    if (lastConnectedId) {
                        const lastConnected = b.workspace.getBlockById(lastConnectedId);
                        if (lastConnected && lastConnected.outputConnection && !lastConnected.outputConnection.targetBlock()) {
                            b.getInput("RETURN_VALUE").connection.connect(lastConnected.outputConnection);
                        }
                        lastConnectedId = undefined;
                    }
                }
                else {
                    if (returnValueInput) {
                        const target = returnValueInput.connection.targetBlock();
                        if (target) {
                            if (target.isShadow())
                                target.setShadow(false);
                            returnValueInput.connection.disconnect();
                            lastConnectedId = target.id;
                        }
                        b.removeInput("RETURN_VALUE");
                        b.jsonInit({
                            "message0": returnDef.block["message_no_value"],
                            "args0": [],
                            "previousStatement": null,
                            "colour": pxt.toolbox.getNamespaceColor('functions')
                        });
                    }
                    if (b.getInput(buttonRemName)) {
                        b.removeInput(buttonRemName);
                    }
                    if (!b.getInput(buttonAddName)) {
                        addPlusButton();
                    }
                }
                b.setInputsInline(true);
            }
            function setReturnValue(mutation, hasReturnValue) {
                mutation.setAttribute("no_return_value", hasReturnValue ? "false" : "true");
            }
            function hasReturnValue(mutation) {
                return mutation.getAttribute("no_return_value") !== "true";
            }
            function addPlusButton() {
                addButton(buttonAddName, b.ADD_IMAGE_DATAURI, lf("Add return value"));
            }
            function addMinusButton() {
                addButton(buttonRemName, b.REMOVE_IMAGE_DATAURI, lf("Remove return value"));
            }
            function mutationString() {
                return Blockly.Xml.domToText(b.mutationToDom());
            }
            function fireMutationChange(pre, post) {
                if (pre !== post)
                    Blockly.Events.fire(new Blockly.Events.BlockChange(b, "mutation", null, pre, post));
            }
            function addButton(name, uri, alt) {
                b.appendDummyInput(name)
                    .appendField(new Blockly.FieldImage(uri, 24, 24, alt, () => {
                    const oldMutation = mutationString();
                    returnValueVisible = !returnValueVisible;
                    const preUpdate = mutationString();
                    fireMutationChange(oldMutation, preUpdate);
                    updateShape();
                    const postUpdate = mutationString();
                    fireMutationChange(preUpdate, postUpdate);
                }, false));
            }
        }
        blocks.initReturnStatement = initReturnStatement;
        class MutationState {
            constructor(block, initState) {
                this.block = block;
                this.fireEvents = true;
                this.state = initState || {};
            }
            setValue(attr, value) {
                if (this.fireEvents && this.block.mutationToDom) {
                    const oldMutation = this.block.mutationToDom();
                    this.state[attr] = value.toString();
                    const newMutation = this.block.mutationToDom();
                    Object.keys(this.state).forEach(key => {
                        if (oldMutation.getAttribute(key) !== this.state[key]) {
                            newMutation.setAttribute(key, this.state[key]);
                        }
                    });
                    const oldText = Blockly.Xml.domToText(oldMutation);
                    const newText = Blockly.Xml.domToText(newMutation);
                    if (oldText != newText) {
                        Blockly.Events.fire(new Blockly.Events.BlockChange(this.block, "mutation", null, oldText, newText));
                    }
                }
                else {
                    this.state[attr] = value.toString();
                }
            }
            getNumber(attr) {
                return parseInt(this.state[attr]);
            }
            getBoolean(attr) {
                return this.state[attr] != "false";
            }
            getString(attr) {
                return this.state[attr];
            }
            setEventsEnabled(enabled) {
                this.fireEvents = enabled;
            }
        }
    })(blocks = pxt.blocks || (pxt.blocks = {}));
})(pxt || (pxt = {}));
var pxt;
(function (pxt) {
    var blocks;
    (function (blocks) {
        const allOperations = pxt.blocks.MATH_FUNCTIONS.unary.concat(pxt.blocks.MATH_FUNCTIONS.binary).concat(pxt.blocks.MATH_FUNCTIONS.infix);
        function initMathOpBlock() {
            const mathOpId = "math_js_op";
            const mathOpDef = pxt.blocks.getBlockDefinition(mathOpId);
            Blockly.Blocks[mathOpId] = {
                init: function () {
                    const b = this;
                    b.setPreviousStatement(false);
                    b.setNextStatement(false);
                    b.setOutput(true, "Number");
                    b.setOutputShape(Blockly.OUTPUT_SHAPE_ROUND);
                    b.setInputsInline(true);
                    const ddi = b.appendDummyInput("op_dropdown");
                    ddi.appendField(new Blockly.FieldDropdown(allOperations.map(op => [mathOpDef.block[op], op]), (op) => onOperatorSelect(b, op)), "OP");
                    addArgInput(b, false);
                    // Because the shape of inputs changes, we need a mutation. Technically the op tells us
                    // how many inputs we should have but we can't read its value at init time
                    blocks.appendMutation(b, {
                        mutationToDom: mutation => {
                            let infix;
                            for (let i = 0; i < b.inputList.length; i++) {
                                const input = b.inputList[i];
                                if (input.name === "op_dropdown") {
                                    infix = false;
                                    break;
                                }
                                else if (input.name === "ARG0") {
                                    infix = true;
                                    break;
                                }
                            }
                            mutation.setAttribute("op-type", (b.getInput("ARG1") ? (infix ? "infix" : "binary") : "unary").toString());
                            return mutation;
                        },
                        domToMutation: saved => {
                            if (saved.hasAttribute("op-type")) {
                                const type = saved.getAttribute("op-type");
                                if (type != "unary") {
                                    addArgInput(b, true);
                                }
                                changeInputOrder(b, type === "infix");
                            }
                        }
                    });
                }
            };
            blocks.installHelpResources(mathOpId, mathOpDef.name, function (block) {
                return mathOpDef.tooltip[block.getFieldValue("OP")];
            }, mathOpDef.url, pxt.toolbox.getNamespaceColor(mathOpDef.category));
            function onOperatorSelect(b, op) {
                if (isUnaryOp(op)) {
                    b.removeInput("ARG1", true);
                }
                else if (!b.getInput("ARG1")) {
                    addArgInput(b, true);
                }
                changeInputOrder(b, isInfixOp(op));
            }
            function addArgInput(b, second) {
                const i = b.appendValueInput("ARG" + (second ? 1 : 0));
                i.setCheck("Number");
                if (second) {
                    i.connection.setShadowDom(numberShadowDom());
                    i.connection.respawnShadow_();
                }
            }
            function changeInputOrder(b, infix) {
                let hasTwoArgs = !!b.getInput("ARG1");
                if (infix) {
                    if (hasTwoArgs) {
                        b.moveInputBefore("op_dropdown", "ARG1");
                    }
                    b.moveInputBefore("ARG0", "op_dropdown");
                }
                else {
                    if (hasTwoArgs) {
                        b.moveInputBefore("ARG0", "ARG1");
                    }
                    b.moveInputBefore("op_dropdown", "ARG0");
                }
            }
        }
        blocks.initMathOpBlock = initMathOpBlock;
        function isUnaryOp(op) {
            return pxt.blocks.MATH_FUNCTIONS.unary.indexOf(op) !== -1;
        }
        function isInfixOp(op) {
            return pxt.blocks.MATH_FUNCTIONS.infix.indexOf(op) !== -1;
        }
        let cachedDom;
        function numberShadowDom() {
            // <shadow type="math_number"><field name="NUM">0</field></shadow>
            if (!cachedDom) {
                cachedDom = document.createElement("shadow");
                cachedDom.setAttribute("type", "math_number");
                const field = document.createElement("field");
                field.setAttribute("name", "NUM");
                field.textContent = "0";
                cachedDom.appendChild(field);
            }
            return cachedDom;
        }
    })(blocks = pxt.blocks || (pxt.blocks = {}));
})(pxt || (pxt = {}));
var pxt;
(function (pxt) {
    var blocks;
    (function (blocks) {
        const allOperations = pxt.blocks.ROUNDING_FUNCTIONS;
        function initMathRoundBlock() {
            const mathRoundId = "math_js_round";
            const mathRoundDef = pxt.blocks.getBlockDefinition(mathRoundId);
            Blockly.Blocks[mathRoundId] = {
                init: function () {
                    const b = this;
                    b.setPreviousStatement(false);
                    b.setNextStatement(false);
                    b.setOutput(true, "Number");
                    b.setOutputShape(Blockly.OUTPUT_SHAPE_ROUND);
                    b.setInputsInline(true);
                    const ddi = b.appendDummyInput("round_dropdown");
                    ddi.appendField(new Blockly.FieldDropdown(allOperations.map(op => [mathRoundDef.block[op], op]), (op) => onOperatorSelect(b, op)), "OP");
                    addArgInput(b);
                }
            };
            blocks.installHelpResources(mathRoundId, mathRoundDef.name, function (block) {
                return mathRoundDef.tooltip[block.getFieldValue("OP")];
            }, mathRoundDef.url, pxt.toolbox.getNamespaceColor(mathRoundDef.category));
            function onOperatorSelect(b, op) {
                // No-op
            }
            function addArgInput(b) {
                const i = b.appendValueInput("ARG0");
                i.setCheck("Number");
            }
        }
        blocks.initMathRoundBlock = initMathRoundBlock;
    })(blocks = pxt.blocks || (pxt.blocks = {}));
})(pxt || (pxt = {}));
var pxtblockly;
(function (pxtblockly) {
    class FieldBase extends Blockly.Field {
        constructor(text, params, validator) {
            super(text, validator);
            this.SERIALIZABLE = true;
            this.options = params;
            if (text && !this.valueText)
                this.valueText = text;
        }
        init() {
            super.init();
            this.onInit();
        }
        dispose() {
            this.onDispose();
        }
        getValue() {
            return this.valueText;
        }
        doValueUpdate_(newValue) {
            if (newValue === null)
                return;
            this.valueText = this.loaded ? this.onValueChanged(newValue) : newValue;
        }
        getDisplayText_() {
            return this.valueText;
        }
        onLoadedIntoWorkspace() {
            if (this.loaded)
                return;
            this.loaded = true;
            this.valueText = this.onValueChanged(this.valueText);
        }
        getAnchorDimensions() {
            const boundingBox = this.getScaledBBox();
            if (this.sourceBlock_.RTL) {
                boundingBox.right += Blockly.FieldDropdown.CHECKMARK_OVERHANG;
            }
            else {
                boundingBox.left -= Blockly.FieldDropdown.CHECKMARK_OVERHANG;
            }
            return boundingBox;
        }
        ;
        isInitialized() {
            return !!this.fieldGroup_;
        }
        getBlockData() {
            return pxt.blocks.getBlockDataForField(this.sourceBlock_, this.name);
        }
        setBlockData(value) {
            pxt.blocks.setBlockDataForField(this.sourceBlock_, this.name, value);
        }
        getSiblingBlock(inputName, useGrandparent = false) {
            const block = useGrandparent ? this.sourceBlock_.parentBlock_ : this.sourceBlock_;
            if (!block || !block.inputList)
                return undefined;
            for (const input of block.inputList) {
                if (input.name === inputName) {
                    return input.connection.targetBlock();
                }
            }
            return undefined;
        }
        getSiblingField(fieldName, useGrandparent = false) {
            const block = useGrandparent ? this.sourceBlock_.parentBlock_ : this.sourceBlock_;
            if (!block)
                return undefined;
            return block.getField(fieldName);
        }
    }
    pxtblockly.FieldBase = FieldBase;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../built/pxtlib.d.ts" />
/// <reference path="./field_base.ts" />
var pxtblockly;
(function (pxtblockly) {
    var svg = pxt.svgUtil;
    // 32 is specifically chosen so that we can scale the images for the default
    // sprite sizes without getting browser anti-aliasing
    const PREVIEW_WIDTH = 32;
    const X_PADDING = 5;
    const Y_PADDING = 1;
    const BG_PADDING = 4;
    const BG_WIDTH = BG_PADDING * 2 + PREVIEW_WIDTH;
    const TOTAL_HEIGHT = Y_PADDING * 2 + BG_PADDING * 2 + PREVIEW_WIDTH;
    const TOTAL_WIDTH = X_PADDING * 2 + BG_PADDING * 2 + PREVIEW_WIDTH;
    class FieldAssetEditor extends pxtblockly.FieldBase {
        constructor(text, params, validator) {
            super(text, params, validator);
            this.pendingEdit = false;
            this.isEmpty = false;
            this.assetChangeListener = () => {
                if (this.pendingEdit)
                    return;
                const id = this.getBlockData();
                if (id) {
                    this.asset = pxt.react.getTilemapProject().lookupAsset(this.getAssetType(), id);
                }
                this.redrawPreview();
            };
            this.lightMode = params.lightMode;
            this.params = this.parseFieldOptions(params);
            this.blocksInfo = params.blocksInfo;
        }
        onInit() {
            this.redrawPreview();
        }
        onValueChanged(newValue) {
            this.parseValueText(newValue);
            this.redrawPreview();
            return this.getValueText();
        }
        showEditor_() {
            if (this.isGreyBlock)
                return;
            const params = Object.assign({}, this.params);
            params.blocksInfo = this.blocksInfo;
            let editorKind;
            switch (this.asset.type) {
                case "tile" /* Tile */:
                case "image" /* Image */:
                    editorKind = "image-editor";
                    params.temporaryAssets = pxtblockly.getTemporaryAssets(this.sourceBlock_.workspace, "image" /* Image */);
                    break;
                case "animation" /* Animation */:
                    editorKind = "animation-editor";
                    params.temporaryAssets = pxtblockly.getTemporaryAssets(this.sourceBlock_.workspace, "image" /* Image */)
                        .concat(pxtblockly.getTemporaryAssets(this.sourceBlock_.workspace, "animation" /* Animation */));
                    break;
                case "tilemap" /* Tilemap */:
                    editorKind = "tilemap-editor";
                    const project = pxt.react.getTilemapProject();
                    pxt.sprite.addMissingTilemapTilesAndReferences(project, this.asset);
                    break;
            }
            const fv = pxt.react.getFieldEditorView(editorKind, this.asset, params);
            if (this.undoRedoState) {
                fv.restorePersistentData(this.undoRedoState);
            }
            pxt.react.getTilemapProject().pushUndo();
            fv.onHide(() => {
                var _a;
                const result = fv.getResult();
                const project = pxt.react.getTilemapProject();
                if (result) {
                    const old = this.getValue();
                    if (pxt.assetEquals(this.asset, result))
                        return;
                    const oldId = isTemporaryAsset(this.asset) ? null : this.asset.id;
                    let newId = isTemporaryAsset(result) ? null : result.id;
                    if (!oldId && newId === this.sourceBlock_.id) {
                        // The temporary assets we create just use the block id as the id; give it something
                        // a little nicer
                        result.id = project.generateNewID(result.type);
                        newId = result.id;
                    }
                    this.pendingEdit = true;
                    if ((_a = result.meta) === null || _a === void 0 ? void 0 : _a.displayName)
                        this.disposeOfTemporaryAsset();
                    this.asset = result;
                    const lastRevision = project.revision();
                    this.onEditorClose(this.asset);
                    this.updateAssetListener();
                    this.updateAssetMeta();
                    this.redrawPreview();
                    this.undoRedoState = fv.getPersistentData();
                    if (this.sourceBlock_ && Blockly.Events.isEnabled()) {
                        const event = new BlocklyTilemapChange(this.sourceBlock_, 'field', this.name, old, this.getValue(), lastRevision, project.revision());
                        if (oldId !== newId) {
                            event.oldAssetId = oldId;
                            event.newAssetId = newId;
                        }
                        Blockly.Events.fire(event);
                    }
                    this.pendingEdit = false;
                }
            });
            fv.show();
        }
        render_() {
            if (this.isGreyBlock && !this.textElement_) {
                this.createTextElement_();
            }
            super.render_();
            if (!this.isGreyBlock) {
                this.size_.height = TOTAL_HEIGHT;
                this.size_.width = TOTAL_WIDTH;
            }
        }
        getDisplayText_() {
            // This is only used when isGreyBlock is true
            if (this.isGreyBlock) {
                const text = pxt.Util.htmlUnescape(this.valueText);
                return text.substr(0, text.indexOf("(")) + "(...)";
            }
            return "";
        }
        updateEditable() {
            if (this.isGreyBlock && this.fieldGroup_) {
                const group = this.fieldGroup_;
                Blockly.utils.dom.removeClass(group, 'blocklyNonEditableText');
                Blockly.utils.dom.removeClass(group, 'blocklyEditableText');
                group.style.cursor = '';
            }
            else {
                super.updateEditable();
            }
        }
        getValue() {
            if (this.isGreyBlock)
                return pxt.Util.htmlUnescape(this.valueText);
            return this.getValueText();
        }
        onDispose() {
            var _a;
            if (((_a = this.sourceBlock_) === null || _a === void 0 ? void 0 : _a.workspace) && !this.sourceBlock_.workspace.rendered) {
                this.disposeOfTemporaryAsset();
            }
            pxt.react.getTilemapProject().removeChangeListener(this.getAssetType(), this.assetChangeListener);
        }
        disposeOfTemporaryAsset() {
            if (this.isTemporaryAsset()) {
                pxt.react.getTilemapProject().removeAsset(this.asset);
                this.setBlockData(null);
                this.asset = undefined;
            }
        }
        clearTemporaryAssetData() {
            if (this.isTemporaryAsset()) {
                this.setBlockData(null);
            }
        }
        isTemporaryAsset() {
            return isTemporaryAsset(this.asset);
        }
        getAsset() {
            return this.asset;
        }
        updateAsset(asset) {
            this.asset = asset;
            this.setValue(this.getValue());
        }
        onEditorClose(newValue) {
            // Subclass
        }
        redrawPreview() {
            if (!this.fieldGroup_)
                return;
            pxsim.U.clear(this.fieldGroup_);
            if (this.isGreyBlock) {
                this.createTextElement_();
                this.render_();
                this.updateEditable();
                return;
            }
            const bg = new svg.Rect()
                .at(X_PADDING, Y_PADDING)
                .size(BG_WIDTH, BG_WIDTH)
                .setClass("blocklySpriteField")
                .stroke("#898989", 1)
                .corner(4);
            this.fieldGroup_.appendChild(bg.el);
            if (this.asset) {
                let dataURI;
                switch (this.asset.type) {
                    case "image" /* Image */:
                    case "tile" /* Tile */:
                        dataURI = pxtblockly.bitmapToImageURI(pxt.sprite.Bitmap.fromData(this.asset.bitmap), PREVIEW_WIDTH, this.lightMode);
                        break;
                    case "animation" /* Animation */:
                        dataURI = pxtblockly.bitmapToImageURI(pxt.sprite.Bitmap.fromData(this.asset.frames[0]), PREVIEW_WIDTH, this.lightMode);
                        break;
                    case "tilemap" /* Tilemap */:
                        dataURI = pxtblockly.tilemapToImageURI(this.asset.data, PREVIEW_WIDTH, this.lightMode);
                        break;
                }
                const img = new svg.Image()
                    .src(dataURI)
                    .at(X_PADDING + BG_PADDING, Y_PADDING + BG_PADDING)
                    .size(PREVIEW_WIDTH, PREVIEW_WIDTH);
                this.fieldGroup_.appendChild(img.el);
            }
        }
        parseValueText(newText) {
            newText = pxt.Util.htmlUnescape(newText);
            if (this.sourceBlock_ && !this.sourceBlock_.isInFlyout) {
                const project = pxt.react.getTilemapProject();
                const id = this.getBlockData();
                const existing = project.lookupAsset(this.getAssetType(), id);
                if (existing && !(newText && this.isEmpty)) {
                    this.asset = existing;
                }
                else {
                    this.setBlockData(null);
                    if (this.asset) {
                        if (this.sourceBlock_ && this.asset.meta.blockIDs) {
                            this.asset.meta.blockIDs = this.asset.meta.blockIDs.filter(id => id !== this.sourceBlock_.id);
                            if (!this.isTemporaryAsset()) {
                                project.updateAsset(this.asset);
                            }
                        }
                    }
                    this.isEmpty = !newText;
                    this.asset = this.createNewAsset(newText);
                }
                this.updateAssetMeta();
                this.updateAssetListener();
            }
        }
        parseFieldOptions(opts) {
            const parsed = {
                initWidth: 16,
                initHeight: 16,
                disableResize: false,
                lightMode: false
            };
            if (!opts) {
                return parsed;
            }
            if (opts.disableResize) {
                parsed.disableResize = opts.disableResize.toLowerCase() === "true" || opts.disableResize === "1";
            }
            parsed.initWidth = withDefault(opts.initWidth, parsed.initWidth);
            parsed.initHeight = withDefault(opts.initHeight, parsed.initHeight);
            parsed.lightMode = opts.lightMode;
            return parsed;
            function withDefault(raw, def) {
                const res = parseInt(raw);
                if (isNaN(res)) {
                    return def;
                }
                return res;
            }
        }
        updateAssetMeta() {
            if (!this.asset)
                return;
            if (!this.asset.meta) {
                this.asset.meta = {};
            }
            if (!this.asset.meta.blockIDs) {
                this.asset.meta.blockIDs = [];
            }
            if (this.sourceBlock_) {
                if (this.asset.meta.blockIDs.indexOf(this.sourceBlock_.id) === -1) {
                    const blockIDs = this.asset.meta.blockIDs;
                    if (blockIDs.length && this.isTemporaryAsset() && blockIDs.some(id => this.sourceBlock_.workspace.getBlockById(id))) {
                        // This temporary asset is already used, so we should clone a copy for ourselves
                        this.asset = pxt.cloneAsset(this.asset);
                        this.asset.meta.blockIDs = [];
                    }
                    this.asset.meta.blockIDs.push(this.sourceBlock_.id);
                }
                this.setBlockData(this.asset.id);
            }
            if (!this.isTemporaryAsset()) {
                pxt.react.getTilemapProject().updateAsset(this.asset);
            }
            else {
                this.asset.meta.temporaryInfo = {
                    blockId: this.sourceBlock_.id,
                    fieldName: this.name
                };
            }
        }
        updateAssetListener() {
            pxt.react.getTilemapProject().removeChangeListener(this.getAssetType(), this.assetChangeListener);
            if (this.asset && !this.isTemporaryAsset()) {
                pxt.react.getTilemapProject().addChangeListener(this.asset, this.assetChangeListener);
            }
        }
    }
    pxtblockly.FieldAssetEditor = FieldAssetEditor;
    function isTemporaryAsset(asset) {
        return asset && !asset.meta.displayName;
    }
    class BlocklyTilemapChange extends Blockly.Events.BlockChange {
        constructor(block, element, name, oldValue, newValue, oldRevision, newRevision) {
            super(block, element, name, oldValue, newValue);
            this.oldRevision = oldRevision;
            this.newRevision = newRevision;
            this.fieldName = name;
        }
        isNull() {
            return this.oldRevision === this.newRevision && super.isNull();
        }
        run(forward) {
            if (this.newAssetId || this.oldAssetId) {
                const block = this.getEventWorkspace_().getBlockById(this.blockId);
                if (forward) {
                    pxt.blocks.setBlockDataForField(block, this.fieldName, this.newAssetId);
                }
                else {
                    pxt.blocks.setBlockDataForField(block, this.fieldName, this.oldAssetId);
                }
            }
            if (forward) {
                pxt.react.getTilemapProject().redo();
                super.run(forward);
            }
            else {
                pxt.react.getTilemapProject().undo();
                super.run(forward);
            }
            const ws = this.getEventWorkspace_();
            // Fire an event to force a recompile, but make sure it doesn't end up on the undo stack
            const ev = new BlocklyTilemapChange(ws.getBlockById(this.blockId), 'tilemap-revision', "revision", null, pxt.react.getTilemapProject().revision(), 0, 0);
            ev.recordUndo = false;
            Blockly.Events.fire(ev);
        }
    }
    pxtblockly.BlocklyTilemapChange = BlocklyTilemapChange;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../built/pxtlib.d.ts" />
/// <reference path="./field_asset.ts" />
var pxtblockly;
(function (pxtblockly) {
    var svg = pxt.svgUtil;
    // 32 is specifically chosen so that we can scale the images for the default
    // sprite sizes without getting browser anti-aliasing
    const PREVIEW_WIDTH = 32;
    const X_PADDING = 5;
    const Y_PADDING = 1;
    const BG_PADDING = 4;
    const BG_WIDTH = BG_PADDING * 2 + PREVIEW_WIDTH;
    const ICON_WIDTH = 30;
    const TOTAL_HEIGHT = Y_PADDING * 2 + BG_PADDING * 2 + PREVIEW_WIDTH;
    const TOTAL_WIDTH = X_PADDING * 2 + BG_PADDING * 2 + PREVIEW_WIDTH + ICON_WIDTH;
    class FieldAnimationEditor extends pxtblockly.FieldAssetEditor {
        constructor() {
            super(...arguments);
            this.onMouseEnter = () => {
                if (this.animateRef || !this.asset)
                    return;
                const assetInterval = this.getParentInterval() || this.asset.interval;
                const interval = assetInterval > 50 ? assetInterval : 50;
                let index = 0;
                this.animateRef = setInterval(() => {
                    if (this.preview && this.frames[index])
                        this.preview.src(this.frames[index]);
                    index = (index + 1) % this.frames.length;
                }, interval);
            };
            this.onMouseLeave = () => {
                if (this.animateRef)
                    clearInterval(this.animateRef);
                this.animateRef = undefined;
                if (this.preview && this.frames[0]) {
                    this.preview.src(this.frames[0]);
                }
            };
        }
        initView() {
            // Register mouseover events for animating preview
            this.sourceBlock_.getSvgRoot().addEventListener("mouseenter", this.onMouseEnter);
            this.sourceBlock_.getSvgRoot().addEventListener("mouseleave", this.onMouseLeave);
        }
        showEditor_() {
            // Read parent interval
            if (this.asset) {
                this.asset.interval = this.getParentInterval() || this.asset.interval;
            }
            super.showEditor_();
        }
        render_() {
            super.render_();
            this.size_.height = TOTAL_HEIGHT;
            this.size_.width = TOTAL_WIDTH;
        }
        getAssetType() {
            return "animation" /* Animation */;
        }
        createNewAsset(text) {
            const project = pxt.react.getTilemapProject();
            if (text) {
                const existing = pxt.lookupProjectAssetByTSReference(text, project);
                if (existing)
                    return existing;
                const frames = parseImageArrayString(text);
                if (frames && frames.length) {
                    const id = this.sourceBlock_.id;
                    const newAnimation = {
                        internalID: -1,
                        id,
                        type: "animation" /* Animation */,
                        frames,
                        interval: this.getParentInterval(),
                        meta: {},
                    };
                    return newAnimation;
                }
                const asset = project.lookupAssetByName("animation" /* Animation */, text.trim());
                if (asset)
                    return asset;
            }
            const id = this.sourceBlock_.id;
            const bitmap = new pxt.sprite.Bitmap(this.params.initWidth, this.params.initHeight).data();
            const newAnimation = {
                internalID: -1,
                id,
                type: "animation" /* Animation */,
                frames: [bitmap],
                interval: 500,
                meta: {},
            };
            return newAnimation;
        }
        onEditorClose(newValue) {
            this.setParentInterval(newValue.interval);
        }
        getValueText() {
            if (!this.asset)
                return "[]";
            if (this.isTemporaryAsset()) {
                return "[" + this.asset.frames.map(frame => pxt.sprite.bitmapToImageLiteral(pxt.sprite.Bitmap.fromData(frame), "typescript" /* TypeScript */)).join(",") + "]";
            }
            return pxt.getTSReferenceForAsset(this.asset);
        }
        redrawPreview() {
            if (!this.fieldGroup_)
                return;
            pxsim.U.clear(this.fieldGroup_);
            const bg = new svg.Rect()
                .at(X_PADDING + ICON_WIDTH, Y_PADDING)
                .size(BG_WIDTH, BG_WIDTH)
                .corner(4)
                .setClass("blocklyAnimationField");
            this.fieldGroup_.appendChild(bg.el);
            const icon = new svg.Text("\uf008")
                .at(X_PADDING, 5 + (TOTAL_HEIGHT >> 1))
                .fill(this.sourceBlock_.getColourSecondary())
                .setClass("semanticIcon");
            this.fieldGroup_.appendChild(icon.el);
            if (this.asset) {
                this.frames = this.asset.frames.map(frame => pxtblockly.bitmapToImageURI(pxt.sprite.Bitmap.fromData(frame), PREVIEW_WIDTH, this.lightMode));
                this.preview = new svg.Image()
                    .src(this.frames[0])
                    .at(X_PADDING + BG_PADDING + ICON_WIDTH, Y_PADDING + BG_PADDING)
                    .size(PREVIEW_WIDTH, PREVIEW_WIDTH);
                this.fieldGroup_.appendChild(this.preview.el);
            }
        }
        getParentIntervalBlock() {
            const s = this.sourceBlock_;
            if (s.parentBlock_) {
                const p = s.parentBlock_;
                for (const input of p.inputList) {
                    if (input.name === "frameInterval") {
                        return input.connection.targetBlock();
                    }
                }
            }
            return undefined;
        }
        setParentInterval(interval) {
            const target = this.getParentIntervalBlock();
            if (target) {
                const fieldName = getFieldName(target);
                if (fieldName) {
                    target.setFieldValue(String(interval), fieldName);
                }
            }
        }
        getParentInterval() {
            const target = this.getParentIntervalBlock();
            if (target) {
                const fieldName = getFieldName(target);
                if (fieldName) {
                    return Number(target.getFieldValue(fieldName));
                }
            }
            return 100;
        }
        parseFieldOptions(opts) {
            return parseFieldOptions(opts);
        }
    }
    pxtblockly.FieldAnimationEditor = FieldAnimationEditor;
    function parseFieldOptions(opts) {
        const parsed = {
            initWidth: 16,
            initHeight: 16,
            disableResize: false,
            lightMode: false
        };
        if (!opts) {
            return parsed;
        }
        parsed.lightMode = opts.lightMode;
        if (opts.filter) {
            parsed.filter = opts.filter;
        }
        parsed.initWidth = withDefault(opts.initWidth, parsed.initWidth);
        parsed.initHeight = withDefault(opts.initHeight, parsed.initHeight);
        return parsed;
        function withDefault(raw, def) {
            const res = parseInt(raw);
            if (isNaN(res)) {
                return def;
            }
            return res;
        }
    }
    function parseImageArrayString(str) {
        if (str.indexOf("[") === -1)
            return null;
        str = str.replace(/[\[\]]/mg, "");
        return str.split(",").map(s => pxt.sprite.imageLiteralToBitmap(s).data()).filter(b => b.height && b.width);
    }
    function isNumberType(type) {
        return type === "math_number" || type === "math_integer" || type === "math_whole_number";
    }
    function getFieldName(target) {
        if (target.type === "math_number_minmax") {
            return "SLIDER";
        }
        else if (isNumberType(target.type)) {
            return "NUM";
        }
        else if (target.type === "timePicker") {
            return "ms";
        }
        return null;
    }
})(pxtblockly || (pxtblockly = {}));
var pxtblockly;
(function (pxtblockly) {
    /**
     * Subclass of FieldVariable to filter out the "delete" option when
     * variables are part of a function argument (or else the whole function
     * gets deleted).
    */
    class FieldArgumentVariable extends Blockly.FieldVariable {
        constructor(varName) {
            super(varName);
            this.menuGenerator_ = this.dropdownCreate;
        }
        dropdownCreate() {
            const options = Blockly.FieldVariable.dropdownCreate.call(this);
            return options.filter((opt) => opt[1] != Blockly.DELETE_VARIABLE_ID);
        }
    }
    pxtblockly.FieldArgumentVariable = FieldArgumentVariable;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/pxtblockly.d.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldTextDropdown extends Blockly.FieldTextDropdown {
        constructor(text, options, opt_validator) {
            super(text, options.values, opt_validator);
            this.isFieldCustom_ = true;
        }
    }
    pxtblockly.FieldTextDropdown = FieldTextDropdown;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/pxtblockly.d.ts" />
/// <reference path="./field_textdropdown.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldAutoComplete extends Blockly.FieldTextDropdown {
        constructor(text, options, opt_validator) {
            super(text, () => [], opt_validator);
            this.isFieldCustom_ = true;
            this.key = options.key;
            this.isTextValid_ = true;
        }
        isOptionListDynamic() {
            return true;
        }
        getDisplayText_() {
            return this.parsedValue || "";
        }
        doValueUpdate_(newValue) {
            if (newValue === null)
                return;
            if (/['"`].*['"`]/.test(newValue)) {
                this.parsedValue = JSON.parse(newValue);
            }
            else {
                this.parsedValue = newValue;
            }
            this.value_ = this.parsedValue;
        }
        getValue() {
            if (this.parsedValue) {
                return JSON.stringify(this.parsedValue);
            }
            else
                return '""';
        }
        getOptions() {
            var _a;
            const workspace = (_a = this.sourceBlock_) === null || _a === void 0 ? void 0 : _a.workspace;
            if (!workspace)
                return [];
            const res = [];
            const fields = pxtblockly.getAllFields(workspace, field => field instanceof FieldAutoComplete && field.getKey() === this.key);
            const options = fields.map(field => field.ref.getDisplayText_());
            for (const option of options) {
                if (!option.trim() || res.some(tuple => tuple[0] === option))
                    continue;
                res.push([option, option]);
            }
            res.sort((a, b) => a[0].localeCompare(b[0]));
            return res;
        }
        showDropdown_() {
            const options = this.getOptions();
            if (options.length)
                super.showDropdown_();
        }
        getKey() {
            if (this.key)
                return this.key;
            if (this.sourceBlock_)
                return this.sourceBlock_.type;
            return undefined;
        }
        // Copied from field_string in pxt-blockly
        initView() {
            // Add quotes around the string
            // Positioned on updatSize, after text size is calculated.
            this.quoteSize_ = 16;
            this.quoteWidth_ = 8;
            this.quoteLeftX_ = 0;
            this.quoteRightX_ = 0;
            this.quoteY_ = 10;
            if (this.quoteLeft_)
                this.quoteLeft_.parentNode.removeChild(this.quoteLeft_);
            this.quoteLeft_ = Blockly.utils.dom.createSvgElement('text', {
                'font-size': this.quoteSize_ + 'px',
                'class': 'field-text-quote'
            }, this.fieldGroup_);
            super.initView();
            if (this.quoteRight_)
                this.quoteRight_.parentNode.removeChild(this.quoteRight_);
            this.quoteRight_ = Blockly.utils.dom.createSvgElement('text', {
                'font-size': this.quoteSize_ + 'px',
                'class': 'field-text-quote'
            }, this.fieldGroup_);
            this.quoteLeft_.appendChild(document.createTextNode('"'));
            this.quoteRight_.appendChild(document.createTextNode('"'));
        }
        // Copied from field_string in pxt-blockly
        updateSize_() {
            super.updateSize_();
            const sWidth = Math.max(this.size_.width, 1);
            const xPadding = 3;
            let addedWidth = this.positionLeft(sWidth + xPadding);
            this.textElement_.setAttribute('x', addedWidth.toString());
            addedWidth += this.positionRight(addedWidth + sWidth + xPadding);
            this.size_.width = sWidth + addedWidth;
        }
        // Copied from field_string in pxt-blockly
        positionRight(x) {
            if (!this.quoteRight_) {
                return 0;
            }
            let addedWidth = 0;
            if (this.sourceBlock_.RTL) {
                this.quoteRightX_ = Blockly.FieldString.quotePadding;
                addedWidth = this.quoteWidth_ + Blockly.FieldString.quotePadding;
            }
            else {
                this.quoteRightX_ = x + Blockly.FieldString.quotePadding;
                addedWidth = this.quoteWidth_ + Blockly.FieldString.quotePadding;
            }
            this.quoteRight_.setAttribute('transform', 'translate(' + this.quoteRightX_ + ',' + this.quoteY_ + ')');
            return addedWidth;
        }
        // Copied from field_string in pxt-blockly
        positionLeft(x) {
            if (!this.quoteLeft_) {
                return 0;
            }
            let addedWidth = 0;
            if (this.sourceBlock_.RTL) {
                this.quoteLeftX_ = x + this.quoteWidth_ + Blockly.FieldString.quotePadding * 2;
                addedWidth = this.quoteWidth_ + Blockly.FieldString.quotePadding;
            }
            else {
                this.quoteLeftX_ = 0;
                addedWidth = this.quoteWidth_ + Blockly.FieldString.quotePadding;
            }
            this.quoteLeft_.setAttribute('transform', 'translate(' + this.quoteLeftX_ + ',' + this.quoteY_ + ')');
            return addedWidth;
        }
        createSVGArrow_() {
            // This creates the little arrow for dropdown fields. Intentionally
            // do nothing
        }
    }
    pxtblockly.FieldAutoComplete = FieldAutoComplete;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/blockly.d.ts" />
/// <reference path="../../built/pxtsim.d.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldBreakpoint extends Blockly.FieldNumber {
        constructor(state, params, opt_validator) {
            super(state, undefined, undefined, undefined, opt_validator);
            this.isFieldCustom_ = true;
            this.CURSOR = 'pointer';
            this.params = params;
            this.setValue(state);
            this.addArgType('toggle');
            this.type_ = params.type;
        }
        initView() {
            if (!this.fieldGroup_) {
                return;
            }
            // Add an attribute to cassify the type of field.
            if (this.getArgTypes() !== null) {
                if (this.sourceBlock_.isShadow()) {
                    this.sourceBlock_.svgGroup_.setAttribute('data-argument-type', this.getArgTypes());
                }
                else {
                    // Fields without a shadow wrapper, like square dropdowns.
                    this.fieldGroup_.setAttribute('data-argument-type', this.getArgTypes());
                }
            }
            // Adjust X to be flipped for RTL. Position is relative to horizontal start of source block.
            const size = this.getSize();
            this.checkElement_ = Blockly.utils.dom.createSvgElement('g', {
                'class': `blocklyToggle ${this.state_ ? 'blocklyToggleOnBreakpoint' : 'blocklyToggleOffBreakpoint'}`,
                'transform': `translate(8, ${size.height / 2})`,
            }, this.fieldGroup_);
            this.toggleThumb_ = Blockly.utils.dom.createSvgElement('polygon', {
                'class': 'blocklyToggleRect',
                'points': '50,5 100,5 125,30 125,80 100,105 50,105 25,80 25,30'
            }, this.checkElement_);
            let fieldX = (this.sourceBlock_.RTL) ? -size.width / 2 : size.width / 2;
            /** @type {!Element} */
            this.textElement_ = Blockly.utils.dom.createSvgElement('text', {
                'class': 'blocklyText',
                'x': fieldX,
                'dy': '0.6ex',
                'y': size.height / 2
            }, this.fieldGroup_);
            this.switchToggle(this.state_);
            this.setValue(this.getValue());
            // Force a render.
            this.markDirty();
        }
        updateSize_() {
            this.size_.width = 30;
        }
        /**
         * Return 'TRUE' if the toggle is ON, 'FALSE' otherwise.
         * @return {string} Current state.
         */
        getValue() {
            return this.toVal(this.state_);
        }
        ;
        /**
         * Set the checkbox to be checked if newBool is 'TRUE' or true,
         * unchecks otherwise.
         * @param {string|boolean} newBool New state.
         */
        setValue(newBool) {
            let newState = this.fromVal(newBool);
            if (this.state_ !== newState) {
                if (this.sourceBlock_ && Blockly.Events.isEnabled()) {
                    Blockly.Events.fire(new Blockly.Events.BlockChange(this.sourceBlock_, 'field', this.name, this.state_, newState));
                }
                this.state_ = newState;
                this.switchToggle(this.state_);
            }
        }
        switchToggle(newState) {
            if (this.checkElement_) {
                this.updateSize_();
                if (newState) {
                    pxt.BrowserUtils.addClass(this.checkElement_, 'blocklyToggleOnBreakpoint');
                    pxt.BrowserUtils.removeClass(this.checkElement_, 'blocklyToggleOffBreakpoint');
                }
                else {
                    pxt.BrowserUtils.removeClass(this.checkElement_, 'blocklyToggleOnBreakpoint');
                    pxt.BrowserUtils.addClass(this.checkElement_, 'blocklyToggleOffBreakpoint');
                }
                this.checkElement_.setAttribute('transform', `translate(-7, -1) scale(0.3)`);
            }
        }
        updateDisplay_(newValue) {
            super.updateDisplay_(newValue);
            if (this.textElement_)
                pxt.BrowserUtils.addClass(this.textElement_, 'blocklyToggleText');
        }
        render_() {
            if (this.visible_ && this.textElement_) {
                // Replace the text.
                goog.dom.removeChildren(/** @type {!Element} */ (this.textElement_));
                this.updateSize_();
            }
        }
        /**
         * Toggle the state of the toggle.
         * @private
         */
        showEditor_() {
            let newState = !this.state_;
            /*
            if (this.sourceBlock_) {
              // Call any validation function, and allow it to override.
              newState = this.callValidator(newState);
            }*/
            if (newState !== null) {
                this.setValue(this.toVal(newState));
            }
        }
        toVal(newState) {
            if (this.type_ == "number")
                return String(newState ? '1' : '0');
            else
                return String(newState ? 'true' : 'false');
        }
        fromVal(val) {
            if (typeof val == "string") {
                if (val == "1" || val.toUpperCase() == "TRUE")
                    return true;
                return false;
            }
            return !!val;
        }
    }
    pxtblockly.FieldBreakpoint = FieldBreakpoint;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/blockly.d.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldColorWheel extends Blockly.FieldSlider {
        /**
         * Class for a color wheel field.
         * @param {number|string} value The initial content of the field.
         * @param {Function=} opt_validator An optional function that is called
         *     to validate any constraints on what the user entered.  Takes the new
         *     text as an argument and returns either the accepted text, a replacement
         *     text, or null to abort the change.
         * @extends {Blockly.FieldNumber}
         * @constructor
         */
        constructor(value_, params, opt_validator) {
            super(String(value_), '0', '255', '1', '10', 'Color', opt_validator);
            this.isFieldCustom_ = true;
            this.params = params;
            if (this.params['min'])
                this.min_ = parseFloat(this.params['min']);
            if (this.params['max'])
                this.max_ = parseFloat(this.params['max']);
            if (this.params['label'])
                this.labelText_ = this.params['label'];
            if (this.params['channel'])
                this.channel_ = this.params['channel'];
        }
        /**
         * Set the gradient CSS properties for the given node and channel
         * @param {Node} node - The DOM node the gradient will be set on.
         * @private
         */
        setBackground_(node) {
            let gradient = this.createColourStops_().join(',');
            goog.style.setStyle(node, 'background', '-moz-linear-gradient(left, ' + gradient + ')');
            goog.style.setStyle(node, 'background', '-webkit-linear-gradient(left, ' + gradient + ')');
            goog.style.setStyle(node, 'background', '-o-linear-gradient(left, ' + gradient + ')');
            goog.style.setStyle(node, 'background', '-ms-linear-gradient(left, ' + gradient + ')');
            goog.style.setStyle(node, 'background', 'linear-gradient(left, ' + gradient + ')');
            if (this.params['sliderWidth'])
                goog.style.setStyle(node, 'width', `${this.params['sliderWidth']}px`);
        }
        ;
        setReadout_(readout, value) {
            const hexValue = this.colorWheel(parseInt(value), this.channel_);
            // <span class="blocklyColorReadout" style="background-color: ${hexValue};"></span>
            const readoutSpan = document.createElement('span');
            readoutSpan.className = "blocklyColorReadout";
            readoutSpan.style.backgroundColor = `${hexValue}`;
            pxsim.U.clear(readout);
            readout.appendChild(readoutSpan);
        }
        createColourStops_() {
            let stops = [];
            for (let n = 0; n <= 255; n += 20) {
                stops.push(this.colorWheel(n, this.channel_));
            }
            return stops;
        }
        ;
        colorWheel(wheelPos, channel) {
            if (channel == "hsvfast") {
                return this.hsvFast(wheelPos, 255, 255);
            }
            else {
                wheelPos = 255 - wheelPos;
                if (wheelPos < 85) {
                    return this.hex(wheelPos * 3, 255, 255 - wheelPos * 3);
                }
                if (wheelPos < 170) {
                    wheelPos -= 85;
                    return this.hex(255, 255 - wheelPos * 3, wheelPos * 3);
                }
                wheelPos -= 170;
                return this.hex(255 - wheelPos * 3, wheelPos * 3, 255);
            }
        }
        hsvFast(hue, sat, val) {
            let h = (hue % 255) >> 0;
            if (h < 0)
                h += 255;
            // scale down to 0..192
            h = (h * 192 / 255) >> 0;
            //reference: based on FastLED's hsv2rgb rainbow algorithm [https://github.com/FastLED/FastLED](MIT)
            let invsat = 255 - sat;
            let brightness_floor = ((val * invsat) / 255) >> 0;
            let color_amplitude = val - brightness_floor;
            let section = (h / 0x40) >> 0; // [0..2]
            let offset = (h % 0x40) >> 0; // [0..63]
            let rampup = offset;
            let rampdown = (0x40 - 1) - offset;
            let rampup_amp_adj = ((rampup * color_amplitude) / (255 / 4)) >> 0;
            let rampdown_amp_adj = ((rampdown * color_amplitude) / (255 / 4)) >> 0;
            let rampup_adj_with_floor = (rampup_amp_adj + brightness_floor);
            let rampdown_adj_with_floor = (rampdown_amp_adj + brightness_floor);
            let r;
            let g;
            let b;
            if (section) {
                if (section == 1) {
                    // section 1: 0x40..0x7F
                    r = brightness_floor;
                    g = rampdown_adj_with_floor;
                    b = rampup_adj_with_floor;
                }
                else {
                    // section 2; 0x80..0xBF
                    r = rampup_adj_with_floor;
                    g = brightness_floor;
                    b = rampdown_adj_with_floor;
                }
            }
            else {
                // section 0: 0x00..0x3F
                r = rampdown_adj_with_floor;
                g = rampup_adj_with_floor;
                b = brightness_floor;
            }
            return this.hex(r, g, b);
        }
        hex(red, green, blue) {
            return `#${this.componentToHex(red & 0xFF)}${this.componentToHex(green & 0xFF)}${this.componentToHex(blue & 0xFF)}`;
        }
        componentToHex(c) {
            let hex = c.toString(16);
            return hex.length == 1 ? "0" + hex : hex;
        }
    }
    pxtblockly.FieldColorWheel = FieldColorWheel;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/blockly.d.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldColorNumber extends Blockly.FieldColour {
        constructor(text, params, opt_validator) {
            super(text, opt_validator);
            this.isFieldCustom_ = true;
            this.valueMode_ = "rgb";
            if (params.colours)
                this.setColours(JSON.parse(params.colours));
            else if (pxt.appTarget.runtime && pxt.appTarget.runtime.palette) {
                let p = pxt.Util.clone(pxt.appTarget.runtime.palette);
                p[0] = "#dedede";
                let t;
                if (pxt.appTarget.runtime.paletteNames) {
                    t = pxt.Util.clone(pxt.appTarget.runtime.paletteNames);
                    t[0] = lf("transparent");
                }
                this.setColours(p, t);
            }
            // Set to first color in palette (for toolbox)
            this.setValue(this.getColours_()[0]);
            if (params.columns)
                this.setColumns(parseInt(params.columns));
            if (params.className)
                this.className_ = params.className;
            if (params.valueMode)
                this.valueMode_ = params.valueMode;
        }
        /**
         * @override
         */
        applyColour() {
            var _a, _b, _c, _d, _e, _f;
            if (this.borderRect_) {
                this.borderRect_.style.fill = this.value_;
            }
            else if (this.sourceBlock_) {
                (_c = (_b = (_a = this.sourceBlock_) === null || _a === void 0 ? void 0 : _a.pathObject) === null || _b === void 0 ? void 0 : _b.svgPath) === null || _c === void 0 ? void 0 : _c.setAttribute('fill', this.value_);
                (_f = (_e = (_d = this.sourceBlock_) === null || _d === void 0 ? void 0 : _d.pathObject) === null || _e === void 0 ? void 0 : _e.svgPath) === null || _f === void 0 ? void 0 : _f.setAttribute('stroke', '#fff');
            }
        }
        ;
        doClassValidation_(colour) {
            return "string" != typeof colour ? null : parseColour(colour, this.getColours_());
        }
        /**
         * Return the current colour.
         * @param {boolean} opt_asHex optional field if the returned value should be a hex
         * @return {string} Current colour in '#rrggbb' format.
         */
        getValue(opt_asHex) {
            if (opt_asHex)
                return this.value_;
            switch (this.valueMode_) {
                case "hex":
                    return `"${this.value_}"`;
                case "rgb":
                    if (this.value_.indexOf('#') > -1) {
                        return `0x${this.value_.replace(/^#/, '')}`;
                    }
                    else {
                        return this.value_;
                    }
                case "index":
                    if (!this.value_)
                        return "-1";
                    const allColours = this.getColours_();
                    for (let i = 0; i < allColours.length; i++) {
                        if (this.value_.toUpperCase() === allColours[i].toUpperCase()) {
                            return i + "";
                        }
                    }
            }
            return this.value_;
        }
        /**
         * Set the colour.
         * @param {string} colour The new colour in '#rrggbb' format.
         */
        doValueUpdate_(colour) {
            this.value_ = parseColour(colour, this.getColours_());
            this.applyColour();
        }
        showEditor_() {
            super.showEditor_();
            if (this.className_ && this.picker_)
                pxt.BrowserUtils.addClass(this.picker_, this.className_);
        }
        getColours_() {
            return this.colours_;
        }
    }
    pxtblockly.FieldColorNumber = FieldColorNumber;
    function parseColour(colour, allColours) {
        if (colour) {
            const enumSplit = /Colors\.([a-zA-Z]+)/.exec(colour);
            const hexSplit = /(0x|#)([0-9a-fA-F]+)/.exec(colour);
            if (enumSplit) {
                switch (enumSplit[1].toLocaleLowerCase()) {
                    case "red": return "#FF0000";
                    case "orange": return "#FF7F00";
                    case "yellow": return "#FFFF00";
                    case "green": return "#00FF00";
                    case "blue": return "#0000FF";
                    case "indigo": return "#4B0082";
                    case "violet": return "#8A2BE2";
                    case "purple": return "#A033E5";
                    case "pink": return "#FF007F";
                    case "white": return "#FFFFFF";
                    case "black": return "#000000";
                    default: return colour;
                }
            }
            else if (hexSplit) {
                const hexLiteralNumber = hexSplit[2];
                if (hexLiteralNumber.length === 3) {
                    // if shorthand color, return standard hex triple
                    let output = "#";
                    for (let i = 0; i < hexLiteralNumber.length; i++) {
                        const digit = hexLiteralNumber.charAt(i);
                        output += digit + digit;
                    }
                    return output;
                }
                else if (hexLiteralNumber.length === 6) {
                    return "#" + hexLiteralNumber;
                }
            }
            if (allColours) {
                const parsedAsInt = parseInt(colour);
                // Might be the index and not the color
                if (!isNaN(parsedAsInt) && allColours[parsedAsInt] != undefined) {
                    return allColours[parsedAsInt];
                }
                else {
                    return allColours[0];
                }
            }
        }
        return colour;
    }
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/pxtblockly.d.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldGridPicker extends Blockly.FieldDropdown {
        constructor(text, options, validator) {
            super(options.data);
            this.isFieldCustom_ = true;
            /**
             * Callback for when a button is clicked inside the drop-down.
             * Should be bound to the FieldIconMenu.
             * @param {Event} e DOM event for the click/touch
             * @private
             */
            this.buttonClick_ = function (e) {
                let value = e.target.getAttribute('data-value');
                if (value !== null) {
                    this.setValue(value);
                    // Close the picker
                    if (this.closeModal_) {
                        this.close();
                        this.closeModal_ = false;
                    }
                }
            };
            this.buttonClickAndClose_ = function (e) {
                this.closeModal_ = true;
                this.buttonClick_(e);
            };
            this.columns_ = parseInt(options.columns) || 4;
            this.maxRows_ = parseInt(options.maxRows) || 0;
            this.width_ = parseInt(options.width) || 200;
            this.backgroundColour_ = pxtblockly.parseColour(options.colour);
            this.borderColour_ = pxt.toolbox.fadeColor(this.backgroundColour_, 0.4, false);
            let tooltipCfg = {
                xOffset: parseInt(options.tooltipsXOffset) || 15,
                yOffset: parseInt(options.tooltipsYOffset) || -10
            };
            this.tooltipConfig_ = tooltipCfg;
            this.hasSearchBar_ = !!options.hasSearchBar || false;
            this.hideRect_ = !!options.hideRect || false;
        }
        /**
         * When disposing the grid picker, make sure the tooltips are disposed too.
         * @public
         */
        dispose() {
            super.dispose();
            this.disposeTooltip();
            this.disposeIntersectionObserver();
        }
        createTooltip_() {
            if (this.gridTooltip_)
                return;
            // Create tooltip
            this.gridTooltip_ = document.createElement('div');
            this.gridTooltip_.className = 'goog-tooltip blocklyGridPickerTooltip';
            this.gridTooltip_.style.position = 'absolute';
            this.gridTooltip_.style.display = 'none';
            this.gridTooltip_.style.visibility = 'hidden';
            document.body.appendChild(this.gridTooltip_);
        }
        /**
         * Create blocklyGridPickerRows and add them to table container
         * @param options
         * @param tableContainer
         */
        populateTableContainer(options, tableContainer, scrollContainer) {
            pxsim.U.removeChildren(tableContainer);
            if (options.length == 0) {
                this.firstItem_ = undefined;
            }
            for (let i = 0; i < options.length / this.columns_; i++) {
                let row = this.populateRow(i, options, tableContainer);
                tableContainer.appendChild(row);
            }
        }
        /**
         * Populate a single row and add it to table container
         * @param row
         * @param options
         * @param tableContainer
         */
        populateRow(row, options, tableContainer) {
            const columns = this.columns_;
            const rowContent = document.createElement('div');
            rowContent.className = 'blocklyGridPickerRow';
            for (let i = (columns * row); i < Math.min((columns * row) + columns, options.length); i++) {
                let content = options[i][0]; // Human-readable text or image.
                const value = options[i][1]; // Language-neutral value.
                const menuItem = document.createElement('div');
                menuItem.className = 'goog-menuitem goog-option';
                menuItem.setAttribute('id', ':' + i); // For aria-activedescendant
                menuItem.setAttribute('role', 'menuitem');
                menuItem.style.userSelect = 'none';
                menuItem.title = content['alt'] || content;
                menuItem.setAttribute('data-value', value);
                const menuItemContent = document.createElement('div');
                menuItemContent.setAttribute('class', 'goog-menuitem-content');
                menuItemContent.title = content['alt'] || content;
                menuItemContent.setAttribute('data-value', value);
                const hasImages = typeof content == 'object';
                // Set colour
                let backgroundColour = this.backgroundColour_;
                if (value == this.getValue()) {
                    // This option is selected
                    menuItem.setAttribute('aria-selected', 'true');
                    pxt.BrowserUtils.addClass(menuItem, 'goog-option-selected');
                    backgroundColour = this.sourceBlock_.getColourTertiary();
                    // Save so we can scroll to it later
                    this.selectedItemDom = menuItem;
                    if (hasImages && !this.shouldShowTooltips()) {
                        this.updateSelectedBar_(content, value);
                    }
                }
                menuItem.style.backgroundColor = backgroundColour;
                menuItem.style.borderColor = this.borderColour_;
                if (hasImages) {
                    // An image, not text.
                    const buttonImg = new Image(content['width'], content['height']);
                    buttonImg.setAttribute('draggable', 'false');
                    if (!('IntersectionObserver' in window)) {
                        // No intersection observer support, set the image url immediately
                        buttonImg.src = content['src'];
                    }
                    else {
                        buttonImg.src = FieldGridPicker.DEFAULT_IMG;
                        buttonImg.setAttribute('data-src', content['src']);
                        this.observer.observe(buttonImg);
                    }
                    buttonImg.alt = content['alt'] || '';
                    buttonImg.setAttribute('data-value', value);
                    menuItemContent.appendChild(buttonImg);
                }
                else {
                    // text
                    menuItemContent.textContent = content;
                }
                if (this.shouldShowTooltips()) {
                    Blockly.bindEvent_(menuItem, 'click', this, this.buttonClickAndClose_);
                    // Setup hover tooltips
                    const xOffset = (this.sourceBlock_.RTL ? -this.tooltipConfig_.xOffset : this.tooltipConfig_.xOffset);
                    const yOffset = this.tooltipConfig_.yOffset;
                    Blockly.bindEvent_(menuItem, 'mousemove', this, (e) => {
                        if (hasImages) {
                            this.gridTooltip_.style.top = `${e.clientY + yOffset}px`;
                            this.gridTooltip_.style.left = `${e.clientX + xOffset}px`;
                            // Set tooltip text
                            const touchTarget = document.elementFromPoint(e.clientX, e.clientY);
                            const title = touchTarget.title || touchTarget.alt;
                            this.gridTooltip_.textContent = title;
                            // Show the tooltip
                            this.gridTooltip_.style.visibility = title ? 'visible' : 'hidden';
                            this.gridTooltip_.style.display = title ? '' : 'none';
                        }
                        pxt.BrowserUtils.addClass(menuItem, 'goog-menuitem-highlight');
                        tableContainer.setAttribute('aria-activedescendant', menuItem.id);
                    });
                    Blockly.bindEvent_(menuItem, 'mouseout', this, (e) => {
                        if (hasImages) {
                            // Hide the tooltip
                            this.gridTooltip_.style.visibility = 'hidden';
                            this.gridTooltip_.style.display = 'none';
                        }
                        pxt.BrowserUtils.removeClass(menuItem, 'goog-menuitem-highlight');
                        tableContainer.removeAttribute('aria-activedescendant');
                    });
                }
                else {
                    if (hasImages) {
                        // Show the selected bar
                        this.selectedBar_.style.display = '';
                        // Show the selected item (in the selected bar)
                        Blockly.bindEvent_(menuItem, 'click', this, (e) => {
                            if (this.closeModal_) {
                                this.buttonClick_(e);
                            }
                            else {
                                // Clear all current hovers.
                                const currentHovers = tableContainer.getElementsByClassName('goog-menuitem-highlight');
                                for (let i = 0; i < currentHovers.length; i++) {
                                    pxt.BrowserUtils.removeClass(currentHovers[i], 'goog-menuitem-highlight');
                                }
                                // Set hover on current item
                                pxt.BrowserUtils.addClass(menuItem, 'goog-menuitem-highlight');
                                this.updateSelectedBar_(content, value);
                            }
                        });
                    }
                    else {
                        Blockly.bindEvent_(menuItem, 'click', this, this.buttonClickAndClose_);
                        Blockly.bindEvent_(menuItem, 'mouseup', this, this.buttonClickAndClose_);
                    }
                }
                menuItem.appendChild(menuItemContent);
                rowContent.appendChild(menuItem);
                if (i == 0) {
                    this.firstItem_ = menuItem;
                }
            }
            return rowContent;
        }
        /**
         * Whether or not to show a box around the dropdown menu.
         * @return {boolean} True if we should show a box (rect) around the dropdown menu. Otherwise false.
         * @private
         */
        shouldShowRect_() {
            return !this.hideRect_ ? !this.sourceBlock_.isShadow() : false;
        }
        doClassValidation_(newValue) {
            return newValue;
        }
        /**
         * Closes the gridpicker.
         */
        close() {
            this.disposeTooltip();
            Blockly.WidgetDiv.hideIfOwner(this);
            Blockly.Events.setGroup(false);
        }
        /**
         * Getter method
         */
        getFirstItem() {
            return this.firstItem_;
        }
        /**
         * Highlight first item in menu, de-select and de-highlight all others
         */
        highlightFirstItem(tableContainerDom) {
            let menuItemsDom = tableContainerDom.childNodes;
            if (menuItemsDom.length && menuItemsDom[0].childNodes) {
                for (let row = 0; row < menuItemsDom.length; ++row) {
                    let rowLength = menuItemsDom[row].childNodes.length;
                    for (let col = 0; col < rowLength; ++col) {
                        const menuItem = menuItemsDom[row].childNodes[col];
                        pxt.BrowserUtils.removeClass(menuItem, "goog-menuitem-highlight");
                        pxt.BrowserUtils.removeClass(menuItem, "goog-option-selected");
                    }
                }
                let firstItem = menuItemsDom[0].childNodes[0];
                firstItem.className += " goog-menuitem-highlight";
            }
        }
        /**
         * Scroll menu to item that equals current value of gridpicker
         */
        highlightAndScrollSelected(tableContainerDom, scrollContainerDom) {
            if (!this.selectedItemDom)
                return;
            goog.style.scrollIntoContainerView(this.selectedItemDom, scrollContainerDom, true);
        }
        /**
         * Create a dropdown menu under the text.
         * @private
         */
        showEditor_() {
            Blockly.WidgetDiv.show(this, this.sourceBlock_.RTL, () => {
                this.onClose_();
            });
            this.setupIntersectionObserver_();
            this.createTooltip_();
            const tableContainer = document.createElement("div");
            this.positionMenu_(tableContainer);
        }
        positionMenu_(tableContainer) {
            // Record viewport dimensions before adding the dropdown.
            const viewportBBox = Blockly.utils.getViewportBBox();
            const anchorBBox = this.getAnchorDimensions_();
            const { paddingContainer, scrollContainer } = this.createWidget_(tableContainer);
            const containerSize = {
                width: paddingContainer.offsetWidth,
                height: paddingContainer.offsetHeight
            }; //goog.style.getSize(paddingContainer);
            // Set width
            const windowSize = goog.dom.getViewportSize();
            if (this.width_ > windowSize.width) {
                this.width_ = windowSize.width;
            }
            tableContainer.style.width = this.width_ + 'px';
            let addedHeight = 0;
            if (this.hasSearchBar_)
                addedHeight += 50; // Account for search bar
            if (this.selectedBar_)
                addedHeight += 50; // Account for the selected bar
            // Set height
            if (this.maxRows_) {
                // Calculate height
                const firstRowDom = tableContainer.children[0];
                const rowHeight = firstRowDom.offsetHeight;
                // Compute maxHeight using maxRows + 0.3 to partially show next row, to hint at scrolling
                let maxHeight = rowHeight * (this.maxRows_ + 0.3);
                if (windowSize.height < (maxHeight + addedHeight)) {
                    maxHeight = windowSize.height - addedHeight;
                }
                if (containerSize.height > maxHeight) {
                    scrollContainer.style.overflowY = "auto";
                    goog.style.setHeight(scrollContainer, maxHeight);
                    containerSize.height = maxHeight;
                }
            }
            containerSize.height += addedHeight;
            if (this.sourceBlock_.RTL) {
                Blockly.utils.uiMenu.adjustBBoxesForRTL(viewportBBox, anchorBBox, containerSize);
            }
            // Position the menu.
            Blockly.WidgetDiv.positionWithAnchor(viewportBBox, anchorBBox, containerSize, this.sourceBlock_.RTL);
            //            (<any>scrollContainer).focus();
            this.highlightAndScrollSelected(tableContainer, scrollContainer);
        }
        ;
        shouldShowTooltips() {
            return !pxt.BrowserUtils.isMobile();
        }
        getAnchorDimensions_() {
            const boundingBox = this.getScaledBBox();
            if (this.sourceBlock_.RTL) {
                boundingBox.right += Blockly.FieldDropdown.CHECKMARK_OVERHANG;
            }
            else {
                boundingBox.left -= Blockly.FieldDropdown.CHECKMARK_OVERHANG;
            }
            return boundingBox;
        }
        ;
        createWidget_(tableContainer) {
            const div = Blockly.WidgetDiv.DIV;
            const options = this.getOptions();
            // Container for the menu rows
            tableContainer.setAttribute("role", "menu");
            tableContainer.setAttribute("aria-haspopup", "true");
            // Container used to limit the height of the tableContainer, because the tableContainer uses
            // display: table, which ignores height and maxHeight
            const scrollContainer = document.createElement("div");
            // Needed to correctly style borders and padding around the scrollContainer, because the padding around the
            // scrollContainer is part of the scrollable area and will not be correctly shown at the top and bottom
            // when scrolling
            const paddingContainer = document.createElement("div");
            paddingContainer.style.border = `solid 1px ${this.borderColour_}`;
            tableContainer.style.backgroundColor = this.backgroundColour_;
            scrollContainer.style.backgroundColor = this.backgroundColour_;
            paddingContainer.style.backgroundColor = this.backgroundColour_;
            tableContainer.className = 'blocklyGridPickerMenu';
            scrollContainer.className = 'blocklyGridPickerScroller';
            paddingContainer.className = 'blocklyGridPickerPadder';
            paddingContainer.appendChild(scrollContainer);
            scrollContainer.appendChild(tableContainer);
            div.appendChild(paddingContainer);
            // Search bar
            if (this.hasSearchBar_) {
                const searchBar = this.createSearchBar_(tableContainer, scrollContainer, options);
                paddingContainer.insertBefore(searchBar, paddingContainer.childNodes[0]);
            }
            // Selected bar
            if (!this.shouldShowTooltips()) {
                this.selectedBar_ = this.createSelectedBar_();
                paddingContainer.appendChild(this.selectedBar_);
            }
            // Render elements
            this.populateTableContainer(options, tableContainer, scrollContainer);
            return { paddingContainer, scrollContainer };
        }
        createSearchBar_(tableContainer, scrollContainer, options) {
            const searchBarDiv = document.createElement("div");
            searchBarDiv.setAttribute("class", "ui fluid icon input");
            const searchIcon = document.createElement("i");
            searchIcon.setAttribute("class", "search icon");
            const searchBar = document.createElement("input");
            searchBar.setAttribute("type", "search");
            searchBar.setAttribute("id", "search-bar");
            searchBar.setAttribute("class", "blocklyGridPickerSearchBar");
            searchBar.setAttribute("placeholder", pxt.Util.lf("Search"));
            searchBar.addEventListener("click", () => {
                searchBar.focus();
                searchBar.setSelectionRange(0, searchBar.value.length);
            });
            // Search on key change
            searchBar.addEventListener("keyup", pxt.Util.debounce(() => {
                let text = searchBar.value;
                let re = new RegExp(text, "i");
                let filteredOptions = options.filter((block) => {
                    const alt = block[0].alt; // Human-readable text or image.
                    const value = block[1]; // Language-neutral value.
                    return alt ? re.test(alt) : re.test(value);
                });
                this.populateTableContainer.bind(this)(filteredOptions, tableContainer, scrollContainer);
                if (text) {
                    this.highlightFirstItem(tableContainer);
                }
                else {
                    this.highlightAndScrollSelected(tableContainer, scrollContainer);
                }
                // Hide the tooltip
                this.gridTooltip_.style.visibility = 'hidden';
                this.gridTooltip_.style.display = 'none';
            }, 300, false));
            // Select the first item if the enter key is pressed
            searchBar.addEventListener("keyup", (e) => {
                const code = e.which;
                if (code == 13) { /* Enter key */
                    // Select the first item in the list
                    const firstRow = tableContainer.childNodes[0];
                    if (firstRow) {
                        const firstItem = firstRow.childNodes[0];
                        if (firstItem) {
                            this.closeModal_ = true;
                            firstItem.click();
                        }
                    }
                }
            });
            searchBarDiv.appendChild(searchBar);
            searchBarDiv.appendChild(searchIcon);
            return searchBarDiv;
        }
        createSelectedBar_() {
            const selectedBar = document.createElement("div");
            selectedBar.setAttribute("class", "blocklyGridPickerSelectedBar");
            selectedBar.style.display = 'none';
            const selectedWrapper = document.createElement("div");
            const selectedImgWrapper = document.createElement("div");
            selectedImgWrapper.className = 'blocklyGridPickerSelectedImage';
            selectedWrapper.appendChild(selectedImgWrapper);
            this.selectedImg_ = document.createElement("img");
            this.selectedImg_.setAttribute('width', '30px');
            this.selectedImg_.setAttribute('height', '30px');
            this.selectedImg_.setAttribute('draggable', 'false');
            this.selectedImg_.style.display = 'none';
            this.selectedImg_.src = FieldGridPicker.DEFAULT_IMG;
            selectedImgWrapper.appendChild(this.selectedImg_);
            this.selectedBarText_ = document.createElement("span");
            this.selectedBarText_.className = 'blocklyGridPickerTooltip';
            selectedWrapper.appendChild(this.selectedBarText_);
            const buttonsWrapper = document.createElement("div");
            const buttonsDiv = document.createElement("div");
            buttonsDiv.className = 'ui buttons mini';
            buttonsWrapper.appendChild(buttonsDiv);
            const selectButton = document.createElement("button");
            selectButton.className = "ui button icon green";
            const selectButtonIcon = document.createElement("i");
            selectButtonIcon.className = 'icon check';
            selectButton.appendChild(selectButtonIcon);
            Blockly.bindEvent_(selectButton, 'click', this, () => {
                this.setValue(this.selectedBarValue_);
                this.close();
            });
            const cancelButton = document.createElement("button");
            cancelButton.className = "ui button icon red";
            const cancelButtonIcon = document.createElement("i");
            cancelButtonIcon.className = 'icon cancel';
            cancelButton.appendChild(cancelButtonIcon);
            Blockly.bindEvent_(cancelButton, 'click', this, () => {
                this.close();
            });
            buttonsDiv.appendChild(selectButton);
            buttonsDiv.appendChild(cancelButton);
            selectedBar.appendChild(selectedWrapper);
            selectedBar.appendChild(buttonsWrapper);
            return selectedBar;
        }
        updateSelectedBar_(content, value) {
            if (content['src']) {
                this.selectedImg_.src = content['src'];
                this.selectedImg_.style.display = '';
            }
            this.selectedImg_.alt = content['alt'] || content;
            this.selectedBarText_.textContent = content['alt'] || content;
            this.selectedBarValue_ = value;
        }
        setupIntersectionObserver_() {
            if (!('IntersectionObserver' in window))
                return;
            this.disposeIntersectionObserver();
            // setup intersection observer for the image
            const preloadImage = (el) => {
                const lazyImageUrl = el.getAttribute('data-src');
                if (lazyImageUrl) {
                    el.src = lazyImageUrl;
                    el.removeAttribute('data-src');
                }
            };
            const config = {
                // If the image gets within 50px in the Y axis, start the download.
                rootMargin: '20px 0px',
                threshold: 0.01
            };
            const onIntersection = (entries) => {
                entries.forEach(entry => {
                    // Are we in viewport?
                    if (entry.intersectionRatio > 0) {
                        // Stop watching and load the image
                        this.observer.unobserve(entry.target);
                        preloadImage(entry.target);
                    }
                });
            };
            this.observer = new IntersectionObserver(onIntersection, config);
        }
        disposeIntersectionObserver() {
            if (this.observer) {
                this.observer = null;
            }
        }
        /**
         * Disposes the tooltip DOM.
         * @private
         */
        disposeTooltip() {
            if (this.gridTooltip_) {
                pxsim.U.remove(this.gridTooltip_);
                this.gridTooltip_ = null;
            }
        }
        onClose_() {
            this.disposeTooltip();
        }
    }
    FieldGridPicker.DEFAULT_IMG = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
    pxtblockly.FieldGridPicker = FieldGridPicker;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/pxtblockly.d.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldImageDropdown extends Blockly.FieldDropdown {
        constructor(text, options, validator) {
            super(options.data);
            this.isFieldCustom_ = true;
            /**
             * Callback for when a button is clicked inside the drop-down.
             * Should be bound to the FieldIconMenu.
             * @param {Event} e DOM event for the click/touch
             * @private
             */
            this.buttonClick_ = function (e) {
                let value = e.target.getAttribute('data-value');
                if (!value)
                    return;
                this.setValue(value);
                Blockly.DropDownDiv.hide();
            };
            this.columns_ = parseInt(options.columns);
            this.maxRows_ = parseInt(options.maxRows) || 0;
            this.width_ = parseInt(options.width) || 300;
            this.backgroundColour_ = pxtblockly.parseColour(options.colour);
            this.borderColour_ = pxt.toolbox.fadeColor(this.backgroundColour_, 0.4, false);
        }
        /**
         * Create a dropdown menu under the text.
         * @private
         */
        showEditor_() {
            // If there is an existing drop-down we own, this is a request to hide the drop-down.
            if (Blockly.DropDownDiv.hideIfOwner(this)) {
                return;
            }
            // If there is an existing drop-down someone else owns, hide it immediately and clear it.
            Blockly.DropDownDiv.hideWithoutAnimation();
            Blockly.DropDownDiv.clearContent();
            // Populate the drop-down with the icons for this field.
            let dropdownDiv = Blockly.DropDownDiv.getContentDiv();
            let contentDiv = document.createElement('div');
            // Accessibility properties
            contentDiv.setAttribute('role', 'menu');
            contentDiv.setAttribute('aria-haspopup', 'true');
            const options = this.getOptions();
            let maxButtonHeight = 0;
            for (let i = 0; i < options.length; i++) {
                let content = options[i][0]; // Human-readable text or image.
                const value = options[i][1]; // Language-neutral value.
                // Icons with the type property placeholder take up space but don't have any functionality
                // Use for special-case layouts
                if (content.type == 'placeholder') {
                    let placeholder = document.createElement('span');
                    placeholder.setAttribute('class', 'blocklyDropDownPlaceholder');
                    placeholder.style.width = content.width + 'px';
                    placeholder.style.height = content.height + 'px';
                    contentDiv.appendChild(placeholder);
                    continue;
                }
                let button = document.createElement('button');
                button.setAttribute('id', ':' + i); // For aria-activedescendant
                button.setAttribute('role', 'menuitem');
                button.setAttribute('class', 'blocklyDropDownButton');
                button.title = content.alt;
                let buttonSize = content.height;
                if (this.columns_) {
                    buttonSize = ((this.width_ / this.columns_) - 8);
                    button.style.width = buttonSize + 'px';
                    button.style.height = buttonSize + 'px';
                }
                else {
                    button.style.width = content.width + 'px';
                    button.style.height = content.height + 'px';
                }
                if (buttonSize > maxButtonHeight) {
                    maxButtonHeight = buttonSize;
                }
                let backgroundColor = this.backgroundColour_;
                if (value == this.getValue()) {
                    // This icon is selected, show it in a different colour
                    backgroundColor = this.sourceBlock_.getColourTertiary();
                    button.setAttribute('aria-selected', 'true');
                }
                button.style.backgroundColor = backgroundColor;
                button.style.borderColor = this.borderColour_;
                Blockly.bindEvent_(button, 'click', this, this.buttonClick_);
                Blockly.bindEvent_(button, 'mouseover', button, function () {
                    this.setAttribute('class', 'blocklyDropDownButton blocklyDropDownButtonHover');
                    contentDiv.setAttribute('aria-activedescendant', this.id);
                });
                Blockly.bindEvent_(button, 'mouseout', button, function () {
                    this.setAttribute('class', 'blocklyDropDownButton');
                    contentDiv.removeAttribute('aria-activedescendant');
                });
                let buttonImg = document.createElement('img');
                buttonImg.src = content.src;
                //buttonImg.alt = icon.alt;
                // Upon click/touch, we will be able to get the clicked element as e.target
                // Store a data attribute on all possible click targets so we can match it to the icon.
                button.setAttribute('data-value', value);
                buttonImg.setAttribute('data-value', value);
                button.appendChild(buttonImg);
                contentDiv.appendChild(button);
            }
            contentDiv.style.width = this.width_ + 'px';
            dropdownDiv.appendChild(contentDiv);
            if (this.maxRows_) {
                // Limit the number of rows shown, but add a partial next row to indicate scrolling
                dropdownDiv.style.maxHeight = (this.maxRows_ + 0.4) * (maxButtonHeight + 8) + 'px';
            }
            if (pxt.BrowserUtils.isFirefox()) {
                // This is to compensate for the scrollbar that overlays content in Firefox. It
                // gets removed in onHide_()
                dropdownDiv.style.paddingRight = "20px";
            }
            Blockly.DropDownDiv.setColour(this.backgroundColour_, this.borderColour_);
            Blockly.DropDownDiv.showPositionedByField(this, this.onHide_.bind(this));
            let source = this.sourceBlock_;
            this.savedPrimary_ = source === null || source === void 0 ? void 0 : source.getColour();
            if (source === null || source === void 0 ? void 0 : source.isShadow()) {
                source.setColour(source.getColourTertiary());
            }
            else if (this.borderRect_) {
                this.borderRect_.setAttribute('fill', source.getColourTertiary());
            }
        }
        /**
         * Callback for when the drop-down is hidden.
         */
        onHide_() {
            let content = Blockly.DropDownDiv.getContentDiv();
            content.removeAttribute('role');
            content.removeAttribute('aria-haspopup');
            content.removeAttribute('aria-activedescendant');
            content.style.width = '';
            content.style.paddingRight = '';
            content.style.maxHeight = '';
            let source = this.sourceBlock_;
            if (source === null || source === void 0 ? void 0 : source.isShadow()) {
                this.sourceBlock_.setColour(this.savedPrimary_);
            }
            else if (this.borderRect_) {
                this.borderRect_.setAttribute('fill', this.savedPrimary_);
            }
        }
        ;
    }
    pxtblockly.FieldImageDropdown = FieldImageDropdown;
})(pxtblockly || (pxtblockly = {}));
var pxtblockly;
(function (pxtblockly) {
    class FieldImages extends pxtblockly.FieldImageDropdown {
        constructor(text, options, validator) {
            super(text, options, validator);
            this.isFieldCustom_ = true;
            this.shouldSort_ = options.sort;
            this.addLabel_ = !!options.addLabel;
        }
        /**
         * Create a dropdown menu under the text.
         * @private
         */
        showEditor_() {
            // If there is an existing drop-down we own, this is a request to hide the drop-down.
            if (Blockly.DropDownDiv.hideIfOwner(this)) {
                return;
            }
            let sourceBlock = this.sourceBlock_;
            // If there is an existing drop-down someone else owns, hide it immediately and clear it.
            Blockly.DropDownDiv.hideWithoutAnimation();
            Blockly.DropDownDiv.clearContent();
            // Populate the drop-down with the icons for this field.
            let dropdownDiv = Blockly.DropDownDiv.getContentDiv();
            let contentDiv = document.createElement('div');
            // Accessibility properties
            contentDiv.setAttribute('role', 'menu');
            contentDiv.setAttribute('aria-haspopup', 'true');
            const options = this.getOptions();
            if (this.shouldSort_)
                options.sort();
            for (let i = 0; i < options.length; i++) {
                const content = options[i][0]; // Human-readable text or image.
                const value = options[i][1]; // Language-neutral value.
                // Icons with the type property placeholder take up space but don't have any functionality
                // Use for special-case layouts
                if (content.type == 'placeholder') {
                    let placeholder = document.createElement('span');
                    placeholder.setAttribute('class', 'blocklyDropDownPlaceholder');
                    placeholder.style.width = content.width + 'px';
                    placeholder.style.height = content.height + 'px';
                    contentDiv.appendChild(placeholder);
                    continue;
                }
                let button = document.createElement('button');
                button.setAttribute('id', ':' + i); // For aria-activedescendant
                button.setAttribute('role', 'menuitem');
                button.setAttribute('class', 'blocklyDropDownButton');
                button.title = content.alt;
                if (this.columns_) {
                    button.style.width = ((this.width_ / this.columns_) - 8) + 'px';
                    //button.style.height = ((this.width_ / this.columns_) - 8) + 'px';
                }
                else {
                    button.style.width = content.width + 'px';
                    button.style.height = content.height + 'px';
                }
                let backgroundColor = sourceBlock.getColour();
                if (value == this.getValue()) {
                    // This icon is selected, show it in a different colour
                    backgroundColor = sourceBlock.getColourTertiary();
                    button.setAttribute('aria-selected', 'true');
                }
                button.style.backgroundColor = backgroundColor;
                button.style.borderColor = sourceBlock.getColourTertiary();
                Blockly.bindEvent_(button, 'click', this, this.buttonClick_);
                Blockly.bindEvent_(button, 'mouseover', button, function () {
                    this.setAttribute('class', 'blocklyDropDownButton blocklyDropDownButtonHover');
                    contentDiv.setAttribute('aria-activedescendant', this.id);
                });
                Blockly.bindEvent_(button, 'mouseout', button, function () {
                    this.setAttribute('class', 'blocklyDropDownButton');
                    contentDiv.removeAttribute('aria-activedescendant');
                });
                let buttonImg = document.createElement('img');
                buttonImg.src = content.src;
                //buttonImg.alt = icon.alt;
                // Upon click/touch, we will be able to get the clicked element as e.target
                // Store a data attribute on all possible click targets so we can match it to the icon.
                button.setAttribute('data-value', value);
                buttonImg.setAttribute('data-value', value);
                button.appendChild(buttonImg);
                if (this.addLabel_) {
                    const buttonText = this.createTextNode_(content.alt);
                    buttonText.setAttribute('data-value', value);
                    button.appendChild(buttonText);
                }
                contentDiv.appendChild(button);
            }
            contentDiv.style.width = this.width_ + 'px';
            dropdownDiv.appendChild(contentDiv);
            Blockly.DropDownDiv.setColour(sourceBlock.getColour(), sourceBlock.getColourTertiary());
            // Position based on the field position.
            Blockly.DropDownDiv.showPositionedByField(this, this.onHideCallback.bind(this));
            // Update colour to look selected.
            this.savedPrimary_ = sourceBlock === null || sourceBlock === void 0 ? void 0 : sourceBlock.getColour();
            if (sourceBlock === null || sourceBlock === void 0 ? void 0 : sourceBlock.isShadow()) {
                sourceBlock.setColour(sourceBlock.style.colourTertiary);
            }
            else if (this.borderRect_) {
                this.borderRect_.setAttribute('fill', sourceBlock.style.colourTertiary);
            }
        }
        // Update color (deselect) on dropdown hide
        onHideCallback() {
            let source = this.sourceBlock_;
            if (source === null || source === void 0 ? void 0 : source.isShadow()) {
                source.setColour(this.savedPrimary_);
            }
            else if (this.borderRect_) {
                this.borderRect_.setAttribute('fill', this.savedPrimary_);
            }
        }
        createTextNode_(text) {
            const textSpan = document.createElement('span');
            textSpan.setAttribute('class', 'blocklyDropdownTextLabel');
            textSpan.textContent = text;
            return textSpan;
        }
    }
    pxtblockly.FieldImages = FieldImages;
})(pxtblockly || (pxtblockly = {}));
var pxtblockly;
(function (pxtblockly) {
    class FieldKind extends Blockly.FieldDropdown {
        constructor(opts) {
            super(createMenuGenerator(opts));
            this.opts = opts;
        }
        initView() {
            super.initView();
        }
        onItemSelected_(menu, menuItem) {
            const value = menuItem.getValue();
            if (value === "CREATE") {
                promptAndCreateKind(this.sourceBlock_.workspace, this.opts, lf("New {0}:", this.opts.memberName), newName => newName && this.setValue(newName));
            }
            else {
                super.onItemSelected_(menu, menuItem);
            }
        }
        doClassValidation_(value) {
            var _a;
            // update cached option list when adding a new kind
            if (((_a = this.opts) === null || _a === void 0 ? void 0 : _a.initialMembers) && !this.opts.initialMembers.find(el => el == value))
                this.getOptions();
            return super.doClassValidation_(value);
        }
        getOptions(opt_useCache) {
            this.initVariables();
            return super.getOptions(opt_useCache);
        }
        initVariables() {
            if (this.sourceBlock_ && this.sourceBlock_.workspace) {
                const ws = this.sourceBlock_.workspace;
                const existing = getExistingKindMembers(ws, this.opts.name);
                this.opts.initialMembers.forEach(memberName => {
                    if (existing.indexOf(memberName) === -1) {
                        createVariableForKind(ws, this.opts, memberName);
                    }
                });
                if (this.getValue() === "CREATE") {
                    if (this.opts.initialMembers.length) {
                        this.setValue(this.opts.initialMembers[0]);
                    }
                }
            }
        }
    }
    pxtblockly.FieldKind = FieldKind;
    function createMenuGenerator(opts) {
        return function () {
            const res = [];
            const that = this;
            if (that.sourceBlock_ && that.sourceBlock_.workspace) {
                const options = that.sourceBlock_.workspace.getVariablesOfType(kindType(opts.name));
                options.forEach(model => {
                    res.push([model.name, model.name]);
                });
            }
            else {
                // Can't create variables from within the flyout, so we just have to fake it
                opts.initialMembers.forEach((e) => res.push([e, e]));
            }
            res.push([lf("Add a new {0}...", opts.memberName), "CREATE"]);
            return res;
        };
    }
    function promptAndCreateKind(ws, opts, message, cb) {
        Blockly.prompt(message, null, response => {
            if (response) {
                let nameIsValid = false;
                if (pxtc.isIdentifierStart(response.charCodeAt(0), 2)) {
                    nameIsValid = true;
                    for (let i = 1; i < response.length; i++) {
                        if (!pxtc.isIdentifierPart(response.charCodeAt(i), 2)) {
                            nameIsValid = false;
                        }
                    }
                }
                if (!nameIsValid) {
                    Blockly.alert(lf("Names must start with a letter and can only contain letters, numbers, '$', and '_'."), () => promptAndCreateKind(ws, opts, message, cb));
                    return;
                }
                if (pxt.blocks.isReservedWord(response)) {
                    Blockly.alert(lf("'{0}' is a reserved word and cannot be used.", response), () => promptAndCreateKind(ws, opts, message, cb));
                    return;
                }
                const existing = getExistingKindMembers(ws, opts.name);
                for (let i = 0; i < existing.length; i++) {
                    const name = existing[i];
                    if (name === response) {
                        Blockly.alert(lf("A {0} named '{1}' already exists.", opts.memberName, response), () => promptAndCreateKind(ws, opts, message, cb));
                        return;
                    }
                }
                if (response === opts.createFunctionName) {
                    Blockly.alert(lf("'{0}' is a reserved name.", opts.createFunctionName), () => promptAndCreateKind(ws, opts, message, cb));
                }
                cb(createVariableForKind(ws, opts, response));
            }
        }, { placeholder: opts.promptHint });
    }
    function getExistingKindMembers(ws, kindName) {
        const existing = ws.getVariablesOfType(kindType(kindName));
        if (existing && existing.length) {
            return existing.map(m => m.name);
        }
        else {
            return [];
        }
    }
    function createVariableForKind(ws, opts, newName) {
        Blockly.Variables.getOrCreateVariablePackage(ws, null, newName, kindType(opts.name));
        return newName;
    }
    function kindType(name) {
        return "KIND_" + name;
    }
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../built/pxtsim.d.ts"/>
const rowRegex = /^.*[\.#].*$/;
var LabelMode;
(function (LabelMode) {
    LabelMode[LabelMode["None"] = 0] = "None";
    LabelMode[LabelMode["Number"] = 1] = "Number";
    LabelMode[LabelMode["Letter"] = 2] = "Letter";
})(LabelMode || (LabelMode = {}));
var pxtblockly;
(function (pxtblockly) {
    class FieldMatrix extends Blockly.Field {
        constructor(text, params, validator) {
            super(text, validator);
            this.isFieldCustom_ = true;
            this.SERIALIZABLE = true;
            this.onColor = "#FFFFFF";
            this.scale = 1;
            // The number of columns
            this.matrixWidth = 5;
            // The number of rows
            this.matrixHeight = 5;
            this.yAxisLabel = LabelMode.None;
            this.xAxisLabel = LabelMode.None;
            this.cellState = [];
            this.cells = [];
            this.dontHandleMouseEvent_ = (ev) => {
                ev.stopPropagation();
                ev.preventDefault();
            };
            this.clearLedDragHandler = (ev) => {
                const svgRoot = this.sourceBlock_.getSvgRoot();
                pxsim.pointerEvents.down.forEach(evid => svgRoot.removeEventListener(evid, this.dontHandleMouseEvent_));
                svgRoot.removeEventListener(pxsim.pointerEvents.move, this.dontHandleMouseEvent_);
                document.removeEventListener(pxsim.pointerEvents.up, this.clearLedDragHandler);
                document.removeEventListener(pxsim.pointerEvents.leave, this.clearLedDragHandler);
                Blockly.Touch.clearTouchIdentifier();
                this.elt.removeEventListener(pxsim.pointerEvents.move, this.handleRootMouseMoveListener);
                ev.stopPropagation();
                ev.preventDefault();
            };
            this.toggleRect = (x, y) => {
                this.cellState[x][y] = this.currentDragState_;
                this.updateValue();
            };
            this.handleRootMouseMoveListener = (ev) => {
                let clientX;
                let clientY;
                if (ev.changedTouches && ev.changedTouches.length == 1) {
                    // Handle touch events
                    clientX = ev.changedTouches[0].clientX;
                    clientY = ev.changedTouches[0].clientY;
                }
                else {
                    // All other events (pointer + mouse)
                    clientX = ev.clientX;
                    clientY = ev.clientY;
                }
                const target = document.elementFromPoint(clientX, clientY);
                if (!target)
                    return;
                const x = target.getAttribute('data-x');
                const y = target.getAttribute('data-y');
                if (x != null && y != null) {
                    this.toggleRect(parseInt(x), parseInt(y));
                }
            };
            this.params = params;
            if (this.params.rows !== undefined) {
                let val = parseInt(this.params.rows);
                if (!isNaN(val)) {
                    this.matrixHeight = val;
                }
            }
            if (this.params.columns !== undefined) {
                let val = parseInt(this.params.columns);
                if (!isNaN(val)) {
                    this.matrixWidth = val;
                }
            }
            if (this.params.onColor !== undefined) {
                this.onColor = this.params.onColor;
            }
            if (this.params.offColor !== undefined) {
                this.offColor = this.params.offColor;
            }
            if (this.params.scale !== undefined)
                this.scale = Math.max(0.6, Math.min(2, Number(this.params.scale)));
            else if (Math.max(this.matrixWidth, this.matrixHeight) > 15)
                this.scale = 0.85;
            else if (Math.max(this.matrixWidth, this.matrixHeight) > 10)
                this.scale = 0.9;
        }
        /**
         * Show the inline free-text editor on top of the text.
         * @private
         */
        showEditor_() {
            // Intentionally left empty
        }
        initMatrix() {
            if (!this.sourceBlock_.isInsertionMarker()) {
                this.elt = pxsim.svg.parseString(`<svg xmlns="http://www.w3.org/2000/svg" id="field-matrix" />`);
                // Initialize the matrix that holds the state
                for (let i = 0; i < this.matrixWidth; i++) {
                    this.cellState.push([]);
                    this.cells.push([]);
                    for (let j = 0; j < this.matrixHeight; j++) {
                        this.cellState[i].push(false);
                    }
                }
                this.restoreStateFromString();
                // Create the cells of the matrix that is displayed
                for (let i = 0; i < this.matrixWidth; i++) {
                    for (let j = 0; j < this.matrixHeight; j++) {
                        this.createCell(i, j);
                    }
                }
                this.updateValue();
                if (this.xAxisLabel !== LabelMode.None) {
                    const y = this.scale * this.matrixHeight * (FieldMatrix.CELL_WIDTH + FieldMatrix.CELL_VERTICAL_MARGIN) + FieldMatrix.CELL_VERTICAL_MARGIN * 2 + FieldMatrix.BOTTOM_MARGIN;
                    const xAxis = pxsim.svg.child(this.elt, "g", { transform: `translate(${0} ${y})` });
                    for (let i = 0; i < this.matrixWidth; i++) {
                        const x = this.getYAxisWidth() + this.scale * i * (FieldMatrix.CELL_WIDTH + FieldMatrix.CELL_HORIZONTAL_MARGIN) + FieldMatrix.CELL_WIDTH / 2 + FieldMatrix.CELL_HORIZONTAL_MARGIN / 2;
                        const lbl = pxsim.svg.child(xAxis, "text", { x, class: "blocklyText" });
                        lbl.textContent = this.getLabel(i, this.xAxisLabel);
                    }
                }
                if (this.yAxisLabel !== LabelMode.None) {
                    const yAxis = pxsim.svg.child(this.elt, "g", {});
                    for (let i = 0; i < this.matrixHeight; i++) {
                        const y = this.scale * i * (FieldMatrix.CELL_WIDTH + FieldMatrix.CELL_VERTICAL_MARGIN) + FieldMatrix.CELL_WIDTH / 2 + FieldMatrix.CELL_VERTICAL_MARGIN * 2;
                        const lbl = pxsim.svg.child(yAxis, "text", { x: 0, y, class: "blocklyText" });
                        lbl.textContent = this.getLabel(i, this.yAxisLabel);
                    }
                }
                this.fieldGroup_.replaceChild(this.elt, this.fieldGroup_.firstChild);
            }
        }
        getLabel(index, mode) {
            switch (mode) {
                case LabelMode.Letter:
                    return String.fromCharCode(index + /*char code for A*/ 65);
                default:
                    return (index + 1).toString();
            }
        }
        createCell(x, y) {
            const tx = this.scale * x * (FieldMatrix.CELL_WIDTH + FieldMatrix.CELL_HORIZONTAL_MARGIN) + FieldMatrix.CELL_HORIZONTAL_MARGIN + this.getYAxisWidth();
            const ty = this.scale * y * (FieldMatrix.CELL_WIDTH + FieldMatrix.CELL_VERTICAL_MARGIN) + FieldMatrix.CELL_VERTICAL_MARGIN;
            const cellG = pxsim.svg.child(this.elt, "g", { transform: `translate(${tx} ${ty})` });
            const cellRect = pxsim.svg.child(cellG, "rect", {
                'class': `blocklyLed${this.cellState[x][y] ? 'On' : 'Off'}`,
                'cursor': 'pointer',
                width: this.scale * FieldMatrix.CELL_WIDTH, height: this.scale * FieldMatrix.CELL_WIDTH,
                fill: this.getColor(x, y),
                'data-x': x,
                'data-y': y,
                rx: Math.max(2, this.scale * FieldMatrix.CELL_CORNER_RADIUS)
            });
            this.cells[x][y] = cellRect;
            if (this.sourceBlock_.workspace.isFlyout)
                return;
            pxsim.pointerEvents.down.forEach(evid => cellRect.addEventListener(evid, (ev) => {
                const svgRoot = this.sourceBlock_.getSvgRoot();
                this.currentDragState_ = !this.cellState[x][y];
                // select and hide chaff
                Blockly.hideChaff();
                this.sourceBlock_.select();
                this.toggleRect(x, y);
                pxsim.pointerEvents.down.forEach(evid => svgRoot.addEventListener(evid, this.dontHandleMouseEvent_));
                svgRoot.addEventListener(pxsim.pointerEvents.move, this.dontHandleMouseEvent_);
                document.addEventListener(pxsim.pointerEvents.up, this.clearLedDragHandler);
                document.addEventListener(pxsim.pointerEvents.leave, this.clearLedDragHandler);
                // Begin listening on the canvas and toggle any matches
                this.elt.addEventListener(pxsim.pointerEvents.move, this.handleRootMouseMoveListener);
                ev.stopPropagation();
                ev.preventDefault();
            }, false));
        }
        getColor(x, y) {
            return this.cellState[x][y] ? this.onColor : (this.offColor || FieldMatrix.DEFAULT_OFF_COLOR);
        }
        getOpacity(x, y) {
            return this.cellState[x][y] ? '1.0' : '0.2';
        }
        updateCell(x, y) {
            const cellRect = this.cells[x][y];
            cellRect.setAttribute("fill", this.getColor(x, y));
            cellRect.setAttribute("fill-opacity", this.getOpacity(x, y));
            cellRect.setAttribute('class', `blocklyLed${this.cellState[x][y] ? 'On' : 'Off'}`);
        }
        setValue(newValue, restoreState = true) {
            super.setValue(String(newValue));
            if (this.elt) {
                if (restoreState)
                    this.restoreStateFromString();
                for (let x = 0; x < this.matrixWidth; x++) {
                    for (let y = 0; y < this.matrixHeight; y++) {
                        this.updateCell(x, y);
                    }
                }
            }
        }
        render_() {
            if (!this.visible_) {
                this.markDirty();
                return;
            }
            if (!this.elt) {
                this.initMatrix();
            }
            // The height and width must be set by the render function
            this.size_.height = this.scale * Number(this.matrixHeight) * (FieldMatrix.CELL_WIDTH + FieldMatrix.CELL_VERTICAL_MARGIN) + FieldMatrix.CELL_VERTICAL_MARGIN * 2 + FieldMatrix.BOTTOM_MARGIN + this.getXAxisHeight();
            this.size_.width = this.scale * Number(this.matrixWidth) * (FieldMatrix.CELL_WIDTH + FieldMatrix.CELL_HORIZONTAL_MARGIN) + this.getYAxisWidth();
        }
        // The return value of this function is inserted in the code
        getValue() {
            // getText() returns the value that is set by calls to setValue()
            let text = removeQuotes(this.value_);
            return `\`\n${FieldMatrix.TAB}${text}\n${FieldMatrix.TAB}\``;
        }
        // Restores the block state from the text value of the field
        restoreStateFromString() {
            let r = this.value_;
            if (r) {
                const rows = r.split("\n").filter(r => rowRegex.test(r));
                for (let y = 0; y < rows.length && y < this.matrixHeight; y++) {
                    let x = 0;
                    const row = rows[y];
                    for (let j = 0; j < row.length && x < this.matrixWidth; j++) {
                        if (isNegativeCharacter(row[j])) {
                            this.cellState[x][y] = false;
                            x++;
                        }
                        else if (isPositiveCharacter(row[j])) {
                            this.cellState[x][y] = true;
                            x++;
                        }
                    }
                }
            }
        }
        // Composes the state into a string an updates the field's state
        updateValue() {
            let res = "";
            for (let y = 0; y < this.matrixHeight; y++) {
                for (let x = 0; x < this.matrixWidth; x++) {
                    res += (this.cellState[x][y] ? "#" : ".") + " ";
                }
                res += "\n" + FieldMatrix.TAB;
            }
            // Blockly stores the state of the field as a string
            this.setValue(res, false);
        }
        getYAxisWidth() {
            return this.yAxisLabel === LabelMode.None ? 0 : FieldMatrix.Y_AXIS_WIDTH;
        }
        getXAxisHeight() {
            return this.xAxisLabel === LabelMode.None ? 0 : FieldMatrix.X_AXIS_HEIGHT;
        }
    }
    FieldMatrix.CELL_WIDTH = 25;
    FieldMatrix.CELL_HORIZONTAL_MARGIN = 7;
    FieldMatrix.CELL_VERTICAL_MARGIN = 5;
    FieldMatrix.CELL_CORNER_RADIUS = 5;
    FieldMatrix.BOTTOM_MARGIN = 9;
    FieldMatrix.Y_AXIS_WIDTH = 9;
    FieldMatrix.X_AXIS_HEIGHT = 10;
    FieldMatrix.TAB = "        ";
    FieldMatrix.DEFAULT_OFF_COLOR = "#000000";
    pxtblockly.FieldMatrix = FieldMatrix;
    function isPositiveCharacter(c) {
        return c === "#" || c === "*" || c === "1";
    }
    function isNegativeCharacter(c) {
        return c === "." || c === "_" || c === "0";
    }
    const allQuotes = ["'", '"', "`"];
    function removeQuotes(str) {
        str = (str || "").trim();
        const start = str.charAt(0);
        if (start === str.charAt(str.length - 1) && allQuotes.indexOf(start) !== -1) {
            return str.substr(1, str.length - 2).trim();
        }
        return str;
    }
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../built/pxtlib.d.ts" />
var pxtblockly;
(function (pxtblockly) {
    var svg = pxt.svgUtil;
    pxtblockly.HEADER_HEIGHT = 50;
    pxtblockly.TOTAL_WIDTH = 300;
    class FieldCustomMelody extends Blockly.Field {
        constructor(value, params, validator) {
            super(value, validator);
            this.isFieldCustom_ = true;
            this.SERIALIZABLE = true;
            this.soundingKeys = 0;
            this.numRow = 8;
            this.numCol = 8;
            this.tempo = 120;
            this.isPlaying = false;
            this.timeouts = []; // keep track of timeouts
            this.params = params;
            this.createMelodyIfDoesntExist();
        }
        init() {
            super.init();
            this.onInit();
        }
        showEditor_() {
            // If there is an existing drop-down someone else owns, hide it immediately and clear it.
            Blockly.DropDownDiv.hideWithoutAnimation();
            Blockly.DropDownDiv.clearContent();
            Blockly.DropDownDiv.setColour(this.getDropdownBackgroundColour(), this.getDropdownBorderColour());
            let contentDiv = Blockly.DropDownDiv.getContentDiv();
            pxt.BrowserUtils.addClass(contentDiv, "melody-content-div");
            pxt.BrowserUtils.addClass(contentDiv.parentElement, "melody-editor-dropdown");
            this.gallery = new pxtmelody.MelodyGallery();
            this.renderEditor(contentDiv);
            this.prevString = this.getValue();
            // The webapp listens to this event and stops the simulator so that you don't get the melody
            // playing twice (once in the editor and once when the code runs in the sim)
            Blockly.Events.fire(new Blockly.Events.Ui(this.sourceBlock_, "melody-editor", false, true));
            Blockly.DropDownDiv.showPositionedByBlock(this, this.sourceBlock_, () => {
                this.onEditorClose();
                // revert all style attributes for dropdown div
                pxt.BrowserUtils.removeClass(contentDiv, "melody-content-div");
                pxt.BrowserUtils.removeClass(contentDiv.parentElement, "melody-editor-dropdown");
                Blockly.Events.fire(new Blockly.Events.Ui(this.sourceBlock_, "melody-editor", true, false));
            });
        }
        getValue() {
            this.stringRep = this.getTypeScriptValue();
            return this.stringRep;
        }
        doValueUpdate_(newValue) {
            if (newValue == null || newValue == "" || newValue == "\"\"" || (this.stringRep && this.stringRep === newValue)) { // ignore empty strings
                return;
            }
            this.stringRep = newValue;
            this.parseTypeScriptValue(newValue);
            super.doValueUpdate_(this.getValue());
        }
        getText_() {
            if (this.invalidString)
                return pxt.Util.lf("Invalid Input");
            else
                return this.getValue();
        }
        // This will be run when the field is created (i.e. when it appears on the workspace)
        onInit() {
            this.render_();
            this.createMelodyIfDoesntExist();
            if (!this.invalidString) {
                if (!this.fieldGroup_) {
                    // Build the DOM.
                    this.fieldGroup_ = Blockly.utils.dom.createSvgElement('g', {}, null);
                }
                if (!this.visible_) {
                    this.fieldGroup_.style.display = 'none';
                }
                this.sourceBlock_.getSvgRoot().appendChild(this.fieldGroup_);
                this.updateFieldLabel();
            }
        }
        render_() {
            super.render_();
            if (!this.invalidString) {
                this.size_.width = FieldCustomMelody.MUSIC_ICON_WIDTH + (FieldCustomMelody.COLOR_BLOCK_WIDTH + FieldCustomMelody.COLOR_BLOCK_SPACING) * this.numCol;
            }
            this.sourceBlock_.setColour("#ffffff");
        }
        // Render the editor that will appear in the dropdown div when the user clicks on the field
        renderEditor(div) {
            let color = this.getDropdownBackgroundColour();
            let secondaryColor = this.getDropdownBorderColour();
            this.topDiv = document.createElement("div");
            pxt.BrowserUtils.addClass(this.topDiv, "melody-top-bar-div");
            // Same toggle set up as sprite editor
            this.root = new svg.SVG(this.topDiv).id("melody-editor-header-controls");
            this.toggle = new Toggle(this.root, { leftText: lf("Editor"), rightText: lf("Gallery"), baseColor: color });
            this.toggle.onStateChange(isLeft => {
                if (isLeft) {
                    this.hideGallery();
                }
                else {
                    this.showGallery();
                }
            });
            this.toggle.layout();
            this.toggle.translate((pxtblockly.TOTAL_WIDTH - this.toggle.width()) / 2, 0);
            div.appendChild(this.topDiv);
            div.appendChild(this.gallery.getElement());
            this.editorDiv = document.createElement("div");
            pxt.BrowserUtils.addClass(this.editorDiv, "melody-editor-div");
            this.editorDiv.style.setProperty("background-color", secondaryColor);
            this.gridDiv = this.createGridDisplay();
            this.editorDiv.appendChild(this.gridDiv);
            this.bottomDiv = document.createElement("div");
            pxt.BrowserUtils.addClass(this.bottomDiv, "melody-bottom-bar-div");
            this.doneButton = document.createElement("button");
            pxt.BrowserUtils.addClass(this.doneButton, "melody-confirm-button");
            this.doneButton.innerText = lf("Done");
            this.doneButton.addEventListener("click", () => this.onDone());
            this.doneButton.style.setProperty("background-color", color);
            this.playButton = document.createElement("button");
            this.playButton.id = "melody-play-button";
            this.playButton.addEventListener("click", () => this.togglePlay());
            this.playIcon = document.createElement("i");
            this.playIcon.id = "melody-play-icon";
            pxt.BrowserUtils.addClass(this.playIcon, "play icon");
            this.playButton.appendChild(this.playIcon);
            this.tempoInput = document.createElement("input");
            pxt.BrowserUtils.addClass(this.tempoInput, "ui input");
            this.tempoInput.type = "number";
            this.tempoInput.title = lf("tempo");
            this.tempoInput.id = "melody-tempo-input";
            this.tempoInput.addEventListener("input", () => this.setTempo(+this.tempoInput.value));
            this.syncTempoField(true);
            this.bottomDiv.appendChild(this.tempoInput);
            this.bottomDiv.appendChild(this.playButton);
            this.bottomDiv.appendChild(this.doneButton);
            this.editorDiv.appendChild(this.bottomDiv);
            div.appendChild(this.editorDiv);
        }
        // Runs when the editor is closed by clicking on the Blockly workspace
        onEditorClose() {
            this.stopMelody();
            if (this.gallery) {
                this.gallery.stopMelody();
            }
            this.clearDomReferences();
            if (this.sourceBlock_ && Blockly.Events.isEnabled() && this.getValue() !== this.prevString) {
                Blockly.Events.fire(new Blockly.Events.BlockChange(this.sourceBlock_, 'field', this.name, this.prevString, this.getValue()));
            }
            this.prevString = undefined;
        }
        // when click done
        onDone() {
            Blockly.DropDownDiv.hideIfOwner(this);
            this.onEditorClose();
        }
        clearDomReferences() {
            this.topDiv = null;
            this.editorDiv = null;
            this.gridDiv = null;
            this.bottomDiv = null;
            this.doneButton = null;
            this.playButton = null;
            this.playIcon = null;
            this.tempoInput = null;
            this.elt = null;
            this.cells = null;
            this.toggle = null;
            this.root = null;
            this.gallery.clearDomReferences();
        }
        // This is the string that will be inserted into the user's TypeScript code
        getTypeScriptValue() {
            if (this.invalidString) {
                return this.invalidString;
            }
            if (this.melody) {
                return "\"" + this.melody.getStringRepresentation() + "\"";
            }
            return "";
        }
        // This should parse the string returned by getTypeScriptValue() and restore the state based on that
        parseTypeScriptValue(value) {
            let oldValue = value;
            try {
                value = value.slice(1, -1); // remove the boundary quotes
                value = value.trim(); // remove boundary white space
                this.createMelodyIfDoesntExist();
                let notes = value.split(" ");
                notes.forEach(n => {
                    if (!this.isValidNote(n))
                        throw new Error(lf("Invalid note '{0}'. Notes can be C D E F G A B C5", n));
                });
                this.melody.resetMelody();
                for (let j = 0; j < notes.length; j++) {
                    if (notes[j] != "-") {
                        let rowPos = pxtmelody.noteToRow(notes[j]);
                        this.melody.updateMelody(rowPos, j);
                    }
                }
                this.updateFieldLabel();
            }
            catch (e) {
                pxt.log(e);
                this.invalidString = oldValue;
            }
        }
        isValidNote(note) {
            switch (note) {
                case "C":
                case "D":
                case "E":
                case "F":
                case "G":
                case "A":
                case "B":
                case "C5":
                case "-": return true;
            }
            return false;
        }
        // The width of the preview on the block itself
        getPreviewWidth() {
            this.updateSize_();
            return this.size_.width;
        }
        // The height of the preview on the block itself
        getPreviewHeight() {
            var _a;
            return ((_a = this.getConstants()) === null || _a === void 0 ? void 0 : _a.FIELD_BORDER_RECT_HEIGHT) || 16;
        }
        getDropdownBackgroundColour() {
            if (this.sourceBlock_.parentBlock_) {
                return this.sourceBlock_.parentBlock_.getColour();
            }
            else {
                return "#3D3D3D";
            }
        }
        getDropdownBorderColour() {
            if (this.sourceBlock_.parentBlock_) {
                return this.sourceBlock_.parentBlock_.getColourTertiary();
            }
            else {
                return "#2A2A2A";
            }
        }
        updateFieldLabel() {
            if (!this.fieldGroup_)
                return;
            pxsim.U.clear(this.fieldGroup_);
            let musicIcon = mkText("\uf001")
                .appendClass("melody-editor-field-icon")
                .at(6, 15);
            this.fieldGroup_.appendChild(musicIcon.el);
            let notes = this.melody.getStringRepresentation().trim().split(" ");
            for (let i = 0; i < notes.length; i++) {
                let className = pxtmelody.getColorClass(pxtmelody.noteToRow(notes[i]));
                const cb = new svg.Rect()
                    .at((FieldCustomMelody.COLOR_BLOCK_WIDTH + FieldCustomMelody.COLOR_BLOCK_SPACING) * i + FieldCustomMelody.COLOR_BLOCK_X, FieldCustomMelody.COLOR_BLOCK_Y)
                    .size(FieldCustomMelody.COLOR_BLOCK_WIDTH, FieldCustomMelody.COLOR_BLOCK_HEIGHT)
                    .stroke("#898989", 1)
                    .corners(3, 2);
                pxt.BrowserUtils.addClass(cb.el, className);
                this.fieldGroup_.appendChild(cb.el);
            }
        }
        setTempo(tempo) {
            // reset text input if input is invalid
            if ((isNaN(tempo) || tempo <= 0) && this.tempoInput) {
                this.tempoInput.value = this.tempo + "";
                return;
            }
            // update tempo and display to reflect new tempo
            if (this.tempo != tempo) {
                this.tempo = tempo;
                if (this.melody) {
                    this.melody.setTempo(this.tempo);
                }
                if (this.tempoInput) {
                    this.tempoInput.value = this.tempo + "";
                }
                this.syncTempoField(false);
            }
        }
        // sync value from tempo field on block with tempo in field editor
        syncTempoField(blockToEditor) {
            const s = this.sourceBlock_;
            if (s.parentBlock_) {
                const p = s.parentBlock_;
                for (const input of p.inputList) {
                    if (input.name === "tempo") {
                        const tempoBlock = input.connection.targetBlock();
                        if (tempoBlock) {
                            if (blockToEditor)
                                if (tempoBlock.getFieldValue("SLIDER")) {
                                    this.tempoInput.value = tempoBlock.getFieldValue("SLIDER");
                                    this.tempo = +this.tempoInput.value;
                                }
                                else {
                                    this.tempoInput.value = this.tempo + "";
                                }
                            else { // Editor to block
                                if (tempoBlock.type === "math_number_minmax") {
                                    tempoBlock.setFieldValue(this.tempoInput.value, "SLIDER");
                                }
                                else {
                                    tempoBlock.setFieldValue(this.tempoInput.value, "NUM");
                                }
                                this.tempoInput.focus();
                            }
                        }
                        break;
                    }
                }
            }
        }
        // ms to hold note
        getDuration() {
            return 60000 / this.tempo;
        }
        createMelodyIfDoesntExist() {
            if (!this.melody) {
                this.melody = new pxtmelody.MelodyArray();
                return true;
            }
            return false;
        }
        onNoteSelect(row, col) {
            // update melody array
            this.invalidString = null;
            this.melody.updateMelody(row, col);
            if (this.melody.getValue(row, col) && !this.isPlaying) {
                this.playNote(row, col);
            }
            this.updateGrid();
            this.updateFieldLabel();
        }
        updateGrid() {
            for (let row = 0; row < this.numRow; row++) {
                const rowClass = pxtmelody.getColorClass(row);
                for (let col = 0; col < this.numCol; col++) {
                    const cell = this.cells[row][col];
                    if (this.melody.getValue(row, col)) {
                        pxt.BrowserUtils.removeClass(cell, "melody-default");
                        pxt.BrowserUtils.addClass(cell, rowClass);
                    }
                    else {
                        pxt.BrowserUtils.addClass(cell, "melody-default");
                        pxt.BrowserUtils.removeClass(cell, rowClass);
                    }
                }
            }
        }
        playNote(rowNumber, colNumber) {
            let count = ++this.soundingKeys;
            if (this.isPlaying) {
                this.timeouts.push(setTimeout(() => {
                    this.playToneCore(rowNumber);
                }, colNumber * this.getDuration()));
                this.timeouts.push(setTimeout(() => {
                    pxt.AudioContextManager.stop();
                }, (colNumber + 1) * this.getDuration()));
            }
            else {
                this.playToneCore(rowNumber);
                this.timeouts.push(setTimeout(() => {
                    if (this.soundingKeys == count)
                        pxt.AudioContextManager.stop();
                }, this.getDuration()));
            }
        }
        queueToneForColumn(column, delay, duration) {
            const start = setTimeout(() => {
                ++this.soundingKeys;
                pxt.AudioContextManager.stop();
                for (let i = 0; i < this.numRow; i++) {
                    if (this.melody.getValue(i, column)) {
                        this.playToneCore(i);
                    }
                }
                this.highlightColumn(column, true);
                this.timeouts = this.timeouts.filter(t => t !== start);
            }, delay);
            const end = setTimeout(() => {
                // pxt.AudioContextManager.stop();
                this.timeouts = this.timeouts.filter(t => t !== end);
                this.highlightColumn(column, false);
            }, delay + duration);
            this.timeouts.push(start);
            this.timeouts.push(end);
        }
        playToneCore(row) {
            let tone = 0;
            switch (row) {
                case 0:
                    tone = 523;
                    break; // Tenor C
                case 1:
                    tone = 494;
                    break; // Middle B
                case 2:
                    tone = 440;
                    break; // Middle A
                case 3:
                    tone = 392;
                    break; // Middle G
                case 4:
                    tone = 349;
                    break; // Middle F
                case 5:
                    tone = 330;
                    break; // Middle E
                case 6:
                    tone = 294;
                    break; // Middle D
                case 7:
                    tone = 262;
                    break; // Middle C
            }
            pxt.AudioContextManager.tone(tone);
        }
        highlightColumn(col, on) {
            const cells = this.cells.map(row => row[col]);
            cells.forEach(cell => {
                if (on)
                    pxt.BrowserUtils.addClass(cell, "playing");
                else
                    pxt.BrowserUtils.removeClass(cell, "playing");
            });
        }
        createGridDisplay() {
            FieldCustomMelody.VIEWBOX_WIDTH = (FieldCustomMelody.CELL_WIDTH + FieldCustomMelody.CELL_VERTICAL_MARGIN) * this.numCol + FieldCustomMelody.CELL_VERTICAL_MARGIN;
            if (pxt.BrowserUtils.isEdge())
                FieldCustomMelody.VIEWBOX_WIDTH += 37;
            FieldCustomMelody.VIEWBOX_HEIGHT = (FieldCustomMelody.CELL_WIDTH + FieldCustomMelody.CELL_HORIZONTAL_MARGIN) * this.numRow + FieldCustomMelody.CELL_HORIZONTAL_MARGIN;
            this.elt = pxsim.svg.parseString(`<svg xmlns="http://www.w3.org/2000/svg" class="melody-grid-div" viewBox="0 0 ${FieldCustomMelody.VIEWBOX_WIDTH} ${FieldCustomMelody.VIEWBOX_HEIGHT}"/>`);
            // Create the cells of the matrix that is displayed
            this.cells = []; // initialize array that holds rect svg elements
            for (let i = 0; i < this.numRow; i++) {
                this.cells.push([]);
            }
            for (let i = 0; i < this.numRow; i++) {
                for (let j = 0; j < this.numCol; j++) {
                    this.createCell(i, j);
                }
            }
            return this.elt;
        }
        createCell(x, y) {
            const tx = x * (FieldCustomMelody.CELL_WIDTH + FieldCustomMelody.CELL_HORIZONTAL_MARGIN) + FieldCustomMelody.CELL_HORIZONTAL_MARGIN;
            const ty = y * (FieldCustomMelody.CELL_WIDTH + FieldCustomMelody.CELL_VERTICAL_MARGIN) + FieldCustomMelody.CELL_VERTICAL_MARGIN;
            const cellG = pxsim.svg.child(this.elt, "g", { transform: `translate(${ty} ${tx})` });
            const cellRect = pxsim.svg.child(cellG, "rect", {
                'cursor': 'pointer',
                'width': FieldCustomMelody.CELL_WIDTH,
                'height': FieldCustomMelody.CELL_WIDTH,
                'stroke': 'white',
                'data-x': x,
                'data-y': y,
                'rx': FieldCustomMelody.CELL_CORNER_RADIUS
            });
            // add appropriate class so the cell has the correct fill color
            if (this.melody.getValue(x, y))
                pxt.BrowserUtils.addClass(cellRect, pxtmelody.getColorClass(x));
            else
                pxt.BrowserUtils.addClass(cellRect, "melody-default");
            if (this.sourceBlock_.workspace.isFlyout)
                return;
            pxsim.pointerEvents.down.forEach(evid => cellRect.addEventListener(evid, (ev) => {
                this.onNoteSelect(x, y);
                ev.stopPropagation();
                ev.preventDefault();
            }, false));
            this.cells[x][y] = cellRect;
        }
        togglePlay() {
            if (!this.isPlaying) {
                this.isPlaying = true;
                this.playMelody();
            }
            else {
                this.stopMelody();
            }
            this.updatePlayButton();
        }
        updatePlayButton() {
            if (this.isPlaying) {
                pxt.BrowserUtils.removeClass(this.playIcon, "play icon");
                pxt.BrowserUtils.addClass(this.playIcon, "stop icon");
            }
            else {
                pxt.BrowserUtils.removeClass(this.playIcon, "stop icon");
                pxt.BrowserUtils.addClass(this.playIcon, "play icon");
            }
        }
        playMelody() {
            if (this.isPlaying) {
                for (let i = 0; i < this.numCol; i++) {
                    this.queueToneForColumn(i, i * this.getDuration(), this.getDuration());
                }
                this.timeouts.push(setTimeout(// call the melody again after it finishes
                () => this.playMelody(), (this.numCol) * this.getDuration()));
            }
            else {
                this.stopMelody();
            }
        }
        stopMelody() {
            if (this.isPlaying) {
                while (this.timeouts.length)
                    clearTimeout(this.timeouts.shift());
                pxt.AudioContextManager.stop();
                this.isPlaying = false;
                this.cells.forEach(row => row.forEach(cell => pxt.BrowserUtils.removeClass(cell, "playing")));
            }
        }
        showGallery() {
            this.stopMelody();
            this.updatePlayButton();
            this.gallery.show((result) => {
                if (result) {
                    this.melody.parseNotes(result);
                    this.gallery.hide();
                    this.toggle.toggle();
                    this.updateFieldLabel();
                    this.updateGrid();
                }
            });
        }
        hideGallery() {
            this.gallery.hide();
        }
    }
    // grid elements
    FieldCustomMelody.CELL_WIDTH = 25;
    FieldCustomMelody.CELL_HORIZONTAL_MARGIN = 7;
    FieldCustomMelody.CELL_VERTICAL_MARGIN = 5;
    FieldCustomMelody.CELL_CORNER_RADIUS = 5;
    // preview field elements
    FieldCustomMelody.COLOR_BLOCK_WIDTH = 10;
    FieldCustomMelody.COLOR_BLOCK_HEIGHT = 20;
    FieldCustomMelody.COLOR_BLOCK_X = 20;
    FieldCustomMelody.COLOR_BLOCK_Y = 5;
    FieldCustomMelody.COLOR_BLOCK_SPACING = 2;
    FieldCustomMelody.MUSIC_ICON_WIDTH = 20;
    pxtblockly.FieldCustomMelody = FieldCustomMelody;
    const TOGGLE_WIDTH = 200;
    const TOGGLE_HEIGHT = 40;
    const TOGGLE_BORDER_WIDTH = 2;
    const TOGGLE_CORNER_RADIUS = 4;
    const BUTTON_CORNER_RADIUS = 2;
    const BUTTON_BORDER_WIDTH = 1;
    const BUTTON_BOTTOM_BORDER_WIDTH = 2;
    class Toggle {
        constructor(parent, props) {
            this.props = defaultColors(props);
            this.root = parent.group();
            this.buildDom();
            this.isLeft = true;
        }
        buildDom() {
            // Our css minifier mangles animation names so they need to be injected manually
            this.root.style().content(`
            .toggle-left {
                transform: translateX(0px);
                animation: mvleft 0.2s 0s ease;
            }

            .toggle-right {
                transform: translateX(100px);
                animation: mvright 0.2s 0s ease;
            }

            @keyframes mvright {
                0% {
                    transform: translateX(0px);
                }
                100% {
                    transform: translateX(100px);
                }
            }

            @keyframes mvleft {
                0% {
                    transform: translateX(100px);
                }
                100% {
                    transform: translateX(0px);
                }
            }
            `);
            // The outer border has an inner-stroke so we need to clip out the outer part
            // because SVG's don't support "inner borders"
            const clip = this.root.def().create("clipPath", "sprite-editor-toggle-border")
                .clipPathUnits(true);
            clip.draw("rect")
                .at(0, 0)
                .corners(TOGGLE_CORNER_RADIUS / TOGGLE_WIDTH, TOGGLE_CORNER_RADIUS / TOGGLE_HEIGHT)
                .size(1, 1);
            // Draw the outer border
            this.root.draw("rect")
                .size(TOGGLE_WIDTH, TOGGLE_HEIGHT)
                .fill(this.props.baseColor)
                .stroke(this.props.borderColor, TOGGLE_BORDER_WIDTH * 2)
                .corners(TOGGLE_CORNER_RADIUS, TOGGLE_CORNER_RADIUS)
                .clipPath("url(#sprite-editor-toggle-border)");
            // Draw the background
            this.root.draw("rect")
                .at(TOGGLE_BORDER_WIDTH, TOGGLE_BORDER_WIDTH)
                .size(TOGGLE_WIDTH - TOGGLE_BORDER_WIDTH * 2, TOGGLE_HEIGHT - TOGGLE_BORDER_WIDTH * 2)
                .fill(this.props.backgroundColor)
                .corners(TOGGLE_CORNER_RADIUS, TOGGLE_CORNER_RADIUS);
            // Draw the switch
            this.switch = this.root.draw("rect")
                .at(TOGGLE_BORDER_WIDTH, TOGGLE_BORDER_WIDTH)
                .size((TOGGLE_WIDTH - TOGGLE_BORDER_WIDTH * 2) / 2, TOGGLE_HEIGHT - TOGGLE_BORDER_WIDTH * 2)
                .fill(this.props.switchColor)
                .corners(TOGGLE_CORNER_RADIUS, TOGGLE_CORNER_RADIUS);
            // Draw the left option
            this.leftElement = this.root.group();
            this.leftText = mkText(this.props.leftText)
                .appendClass("sprite-editor-text")
                .fill(this.props.selectedTextColor);
            this.leftElement.appendChild(this.leftText);
            // Draw the right option
            this.rightElement = this.root.group();
            this.rightText = mkText(this.props.rightText)
                .appendClass("sprite-editor-text")
                .fill(this.props.unselectedTextColor);
            this.rightElement.appendChild(this.rightText);
            this.root.onClick(() => this.toggle());
        }
        toggle(quiet = false) {
            if (this.isLeft) {
                this.switch.removeClass("toggle-left");
                this.switch.appendClass("toggle-right");
                this.leftText.fill(this.props.unselectedTextColor);
                this.rightText.fill(this.props.selectedTextColor);
            }
            else {
                this.switch.removeClass("toggle-right");
                this.switch.appendClass("toggle-left");
                this.leftText.fill(this.props.selectedTextColor);
                this.rightText.fill(this.props.unselectedTextColor);
            }
            this.isLeft = !this.isLeft;
            if (!quiet && this.changeHandler) {
                this.changeHandler(this.isLeft);
            }
        }
        onStateChange(handler) {
            this.changeHandler = handler;
        }
        layout() {
            const centerOffset = (TOGGLE_WIDTH - TOGGLE_BORDER_WIDTH * 2) / 4;
            this.leftText.moveTo(centerOffset + TOGGLE_BORDER_WIDTH, TOGGLE_HEIGHT / 2);
            this.rightText.moveTo(TOGGLE_WIDTH - TOGGLE_BORDER_WIDTH - centerOffset, TOGGLE_HEIGHT / 2);
        }
        translate(x, y) {
            this.root.translate(x, y);
        }
        height() {
            return TOGGLE_HEIGHT;
        }
        width() {
            return TOGGLE_WIDTH;
        }
    }
    function mkText(text) {
        return new svg.Text(text)
            .anchor("middle")
            .setAttribute("dominant-baseline", "middle")
            .setAttribute("dy", (pxt.BrowserUtils.isIE() || pxt.BrowserUtils.isEdge()) ? "0.3em" : "0.1em");
    }
    function defaultColors(props) {
        if (!props.baseColor)
            props.baseColor = "#e95153";
        if (!props.backgroundColor)
            props.backgroundColor = "rgba(52,73,94,.2)";
        if (!props.borderColor)
            props.borderColor = "rgba(52,73,94,.4)";
        if (!props.selectedTextColor)
            props.selectedTextColor = props.baseColor;
        if (!props.unselectedTextColor)
            props.unselectedTextColor = "hsla(0,0%,100%,.9)";
        if (!props.switchColor)
            props.switchColor = "#ffffff";
        return props;
    }
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/pxtblockly.d.ts" />
var pxtblockly;
(function (pxtblockly) {
    let Note;
    (function (Note) {
        Note[Note["C"] = 262] = "C";
        Note[Note["CSharp"] = 277] = "CSharp";
        Note[Note["D"] = 294] = "D";
        Note[Note["Eb"] = 311] = "Eb";
        Note[Note["E"] = 330] = "E";
        Note[Note["F"] = 349] = "F";
        Note[Note["FSharp"] = 370] = "FSharp";
        Note[Note["G"] = 392] = "G";
        Note[Note["GSharp"] = 415] = "GSharp";
        Note[Note["A"] = 440] = "A";
        Note[Note["Bb"] = 466] = "Bb";
        Note[Note["B"] = 494] = "B";
        Note[Note["C3"] = 131] = "C3";
        Note[Note["CSharp3"] = 139] = "CSharp3";
        Note[Note["D3"] = 147] = "D3";
        Note[Note["Eb3"] = 156] = "Eb3";
        Note[Note["E3"] = 165] = "E3";
        Note[Note["F3"] = 175] = "F3";
        Note[Note["FSharp3"] = 185] = "FSharp3";
        Note[Note["G3"] = 196] = "G3";
        Note[Note["GSharp3"] = 208] = "GSharp3";
        Note[Note["A3"] = 220] = "A3";
        Note[Note["Bb3"] = 233] = "Bb3";
        Note[Note["B3"] = 247] = "B3";
        Note[Note["C4"] = 262] = "C4";
        Note[Note["CSharp4"] = 277] = "CSharp4";
        Note[Note["D4"] = 294] = "D4";
        Note[Note["Eb4"] = 311] = "Eb4";
        Note[Note["E4"] = 330] = "E4";
        Note[Note["F4"] = 349] = "F4";
        Note[Note["FSharp4"] = 370] = "FSharp4";
        Note[Note["G4"] = 392] = "G4";
        Note[Note["GSharp4"] = 415] = "GSharp4";
        Note[Note["A4"] = 440] = "A4";
        Note[Note["Bb4"] = 466] = "Bb4";
        Note[Note["B4"] = 494] = "B4";
        Note[Note["C5"] = 523] = "C5";
        Note[Note["CSharp5"] = 555] = "CSharp5";
        Note[Note["D5"] = 587] = "D5";
        Note[Note["Eb5"] = 622] = "Eb5";
        Note[Note["E5"] = 659] = "E5";
        Note[Note["F5"] = 698] = "F5";
        Note[Note["FSharp5"] = 740] = "FSharp5";
        Note[Note["G5"] = 784] = "G5";
        Note[Note["GSharp5"] = 831] = "GSharp5";
        Note[Note["A5"] = 880] = "A5";
        Note[Note["Bb5"] = 932] = "Bb5";
        Note[Note["B5"] = 988] = "B5";
        Note[Note["C6"] = 1047] = "C6";
        Note[Note["CSharp6"] = 1109] = "CSharp6";
        Note[Note["D6"] = 1175] = "D6";
        Note[Note["Eb6"] = 1245] = "Eb6";
        Note[Note["E6"] = 1319] = "E6";
        Note[Note["F6"] = 1397] = "F6";
        Note[Note["FSharp6"] = 1480] = "FSharp6";
        Note[Note["G6"] = 1568] = "G6";
        Note[Note["GSharp6"] = 1568] = "GSharp6";
        Note[Note["A6"] = 1760] = "A6";
        Note[Note["Bb6"] = 1865] = "Bb6";
        Note[Note["B6"] = 1976] = "B6";
        Note[Note["C7"] = 2093] = "C7";
    })(Note || (Note = {}));
    class FieldNote extends Blockly.FieldNumber {
        constructor(text, params, validator) {
            // passing null as we need more state before we properly set value.
            super(null, 0, null, null, validator);
            this.isFieldCustom_ = true;
            this.SERIALIZABLE = true;
            this.isTextValid_ = true;
            /**
             * default number of piano keys
             */
            this.nKeys_ = 36;
            this.minNote_ = 28;
            this.maxNote_ = 63;
            /** Absolute error for note frequency identification (Hz) **/
            this.eps = 2;
            this.setSpellcheck(false);
            this.prepareNotes();
            this.isExpanded = false;
            this.currentPage = 0;
            this.totalPlayCount = 0;
            if (params.editorColour) {
                this.primaryColour = pxtblockly.parseColour(params.editorColour);
                this.borderColour = Blockly.utils.colour.darken(this.primaryColour, 0.2);
            }
            const eps = parseInt(params.eps);
            if (!Number.isNaN(eps) && eps >= 0) {
                this.eps = eps;
            }
            const minNote = parseInt(params.minNote) || this.minNote_;
            const maxNote = parseInt(params.maxNote) || this.maxNote_;
            if (minNote >= 28 && maxNote <= 75 && maxNote > minNote) {
                this.minNote_ = minNote;
                this.maxNote_ = maxNote;
                this.nKeys_ = this.maxNote_ - this.minNote_ + 1;
            }
            this.setValue(text);
        }
        /**
         * Ensure that only a non negative number may be entered.
         * @param {string} text The user's text.
         * @return A string representing a valid positive number, or null if invalid.
         */
        doClassValidation_(text) {
            // accommodate note strings like "Note.GSharp5" as well as numbers
            const match = /^Note\.(.+)$/.exec(text);
            const noteName = (match && match.length > 1) ? match[1] : null;
            text = Note[noteName] ? Note[noteName] : String(parseFloat(text || "0"));
            if (text === null) {
                return null;
            }
            const n = parseFloat(text || "0");
            if (isNaN(n) || n < 0) {
                return null;
            }
            const showDecimal = Math.floor(n) != n;
            return "" + n.toFixed(showDecimal ? 2 : 0);
        }
        /**
         * Return the current note frequency.
         * @return Current note in string format.
         */
        getValue() {
            return this.value_ + "";
        }
        /**
         * Called by setValue if the text input is valid. Updates the value of the
         * field, and updates the text of the field if it is not currently being
         * edited (i.e. handled by the htmlInput_).
         * @param {string} note The new note in string format.
         */
        doValueUpdate_(note) {
            if (isNaN(Number(note)) || Number(note) < 0)
                return;
            if (this.sourceBlock_ && Blockly.Events.isEnabled() && this.value_ != note) {
                Blockly.Events.fire(new Blockly.Events.Change(this.sourceBlock_, "field", this.name, this.value_, note));
            }
            this.value_ = note;
            this.refreshText();
        }
        /**
         * Get the text from this field
         * @return Current text.
         */
        getText() {
            if (this.isExpanded) {
                return "" + this.value_;
            }
            else {
                const note = +this.value_;
                for (let i = 0; i < this.nKeys_; i++) {
                    if (Math.abs(this.getKeyFreq(i) - note) < this.eps) {
                        return this.getKeyName(i);
                    }
                }
                let text = note.toString();
                if (!isNaN(note))
                    text += " Hz";
                return text;
            }
        }
        /**
         * This block shows up differently when it's being edited;
         * on any transition between `editing <--> not-editing`
         * or other change in state,
         * refresh the text to get back into a valid state.
         **/
        refreshText() {
            this.forceRerender();
        }
        onHtmlInputChange_(e) {
            super.onHtmlInputChange_(e);
            Blockly.DropDownDiv.hideWithoutAnimation();
            this.htmlInput_.focus();
        }
        onFinishEditing_(text) {
            this.refreshText();
        }
        onHide() {
            this.isExpanded = false;
            this.refreshText();
        }
        ;
        /**
         * Create a piano under the note field.
         */
        showEditor_(e) {
            this.isExpanded = true;
            this.updateColor();
            // If there is an existing drop-down someone else owns, hide it immediately and clear it.
            Blockly.DropDownDiv.hideWithoutAnimation();
            Blockly.DropDownDiv.clearContent();
            const isMobile = pxt.BrowserUtils.isMobile() || pxt.BrowserUtils.isIOS();
            // invoke FieldTextInputs showeditor, so we can set quiet explicitly / not have a pop up dialogue
            FieldNote.superClass_.showEditor_.call(this, e, /** quiet **/ isMobile, /** readonly **/ isMobile);
            this.refreshText();
            // save all changes in the same group of events
            Blockly.Events.setGroup(true);
            this.piano = [];
            this.currentSelectedKey = undefined;
            const totalWhiteKeys = this.nKeys_ - (this.nKeys_ / FieldNote.notesPerOctave * FieldNote.blackKeysPerOctave);
            const whiteKeysPerOctave = FieldNote.notesPerOctave - FieldNote.blackKeysPerOctave;
            let pianoWidth = FieldNote.keyWidth * totalWhiteKeys;
            let pianoHeight = FieldNote.keyHeight + FieldNote.labelHeight;
            const pagination = window.innerWidth < pianoWidth;
            if (pagination) {
                pianoWidth = whiteKeysPerOctave * FieldNote.keyWidth;
                pianoHeight = FieldNote.keyHeight + FieldNote.labelHeight + FieldNote.prevNextHeight;
            }
            const pianoDiv = createStyledDiv("blocklyPianoDiv", `width: ${pianoWidth}px;
                height: ${pianoHeight}px;`);
            Blockly.DropDownDiv.getContentDiv().appendChild(pianoDiv);
            // render note label
            this.noteLabel = createStyledDiv("blocklyNoteLabel", `top: ${FieldNote.keyHeight}px;
                width: ${pianoWidth}px;
                background-color: ${this.primaryColour};
                border-color: ${this.primaryColour};`);
            pianoDiv.appendChild(this.noteLabel);
            this.noteLabel.textContent = "-";
            let startingPage = 0;
            for (let i = 0; i < this.nKeys_; i++) {
                const currentOctave = Math.floor(i / FieldNote.notesPerOctave);
                let position = this.getPosition(i);
                // modify original position in pagination
                if (pagination && i >= FieldNote.notesPerOctave)
                    position -= whiteKeysPerOctave * currentOctave * FieldNote.keyWidth;
                const key = this.getKeyDiv(i, position);
                this.piano.push(key);
                pianoDiv.appendChild(key);
                // if the current value is within eps of this note, select it.
                if (Math.abs(this.getKeyFreq(i) - Number(this.getValue())) < this.eps) {
                    pxt.BrowserUtils.addClass(key, "selected");
                    this.currentSelectedKey = key;
                    startingPage = currentOctave;
                }
            }
            if (pagination) {
                this.setPage(startingPage);
                pianoDiv.appendChild(this.getNextPrevDiv(/** prev **/ true, pianoWidth));
                pianoDiv.appendChild(this.getNextPrevDiv(/** prev **/ false, pianoWidth));
            }
            Blockly.DropDownDiv.setColour(this.primaryColour, this.borderColour);
            Blockly.DropDownDiv.showPositionedByBlock(this, this.sourceBlock_, () => this.onHide());
        }
        playKey(key, frequency) {
            const notePlayID = ++this.totalPlayCount;
            if (this.currentSelectedKey !== key) {
                if (this.currentSelectedKey)
                    pxt.BrowserUtils.removeClass(this.currentSelectedKey, "selected");
                pxt.BrowserUtils.addClass(key, "selected");
                this.setValue(frequency);
            }
            this.currentSelectedKey = key;
            /**
             * force a rerender of the preview; other attempts at changing the value
             * do not show up on the block itself until after the fieldeditor is closed,
             * as it is currently in an editable state.
             **/
            this.htmlInput_.value = this.getText();
            pxt.AudioContextManager.tone(frequency);
            setTimeout(() => {
                // Clear the sound if it is still playing after 300ms
                if (this.totalPlayCount == notePlayID)
                    pxt.AudioContextManager.stop();
            }, 300);
        }
        /**
         * Close the note picker if this input is being deleted.
         */
        dispose() {
            Blockly.DropDownDiv.hideIfOwner(this);
            super.dispose();
        }
        updateColor() {
            if (this.sourceBlock_.parentBlock_ && (this.sourceBlock_.isShadow() || hasOnlyOneField(this.sourceBlock_))) {
                let b = this.sourceBlock_.parentBlock_;
                this.primaryColour = b.getColour();
                this.borderColour = b.getColourTertiary();
            }
            else {
                this.primaryColour = "#3D3D3D";
                this.borderColour = "#2A2A2A";
            }
        }
        setPage(page) {
            const pageCount = this.nKeys_ / FieldNote.notesPerOctave;
            page = Math.max(Math.min(page, pageCount - 1), 0);
            this.noteLabel.textContent = `Octave #${page + 1}`;
            const firstKeyInOctave = page * FieldNote.notesPerOctave;
            for (let i = 0; i < this.piano.length; ++i) {
                const isInOctave = i >= firstKeyInOctave && i < firstKeyInOctave + FieldNote.notesPerOctave;
                this.piano[i].style.display = isInOctave ? "block" : "none";
            }
            this.currentPage = page;
        }
        ;
        /**
         * create a DOM to assign a style to the previous and next buttons
         * @param pianoWidth the width of the containing piano
         * @param isPrev true if is previous button, false otherwise
         * @return DOM with the new css style.s
         */
        getNextPrevDiv(isPrev, pianoWidth) {
            const xPosition = isPrev ? 0 : (pianoWidth / 2);
            const yPosition = FieldNote.keyHeight + FieldNote.labelHeight;
            const output = createStyledDiv("blocklyNotePrevNext", `top: ${yPosition}px;
                left: ${xPosition}px;
                width: ${Math.ceil(pianoWidth / 2)}px;
                ${isPrev ? "border-left-color" : "border-right-color"}: ${this.primaryColour};
                background-color: ${this.primaryColour};
                border-bottom-color: ${this.primaryColour};`);
            pxt.BrowserUtils.pointerEvents.down.forEach(ev => {
                Blockly.bindEventWithChecks_(output, ev, this, () => this.setPage(isPrev ? this.currentPage - 1 : this.currentPage + 1), 
                /** noCaptureIdentifier **/ true);
            });
            output.textContent = isPrev ? "<" : ">";
            return output;
        }
        getKeyDiv(keyInd, leftPosition) {
            const output = createStyledDiv(`blocklyNote ${this.isWhite(keyInd) ? "" : "black"}`, `width: ${this.getKeyWidth(keyInd)}px;
                height: ${this.getKeyHeight(keyInd)}px;
                left: ${leftPosition}px;
                border-color: ${this.primaryColour};`);
            pxt.BrowserUtils.pointerEvents.down.forEach(ev => {
                Blockly.bindEventWithChecks_(output, ev, this, () => this.playKey(output, this.getKeyFreq(keyInd)), 
                /** noCaptureIdentifier **/ true);
            });
            Blockly.bindEventWithChecks_(output, 'mouseover', this, () => this.noteLabel.textContent = this.getKeyName(keyInd), 
            /** noCaptureIdentifier **/ true);
            return output;
        }
        /**
         * @param idx index of the key
         * @return true if idx is white
         */
        isWhite(idx) {
            switch (idx % 12) {
                case 1:
                case 3:
                case 6:
                case 8:
                case 10:
                    return false;
                default:
                    return true;
            }
        }
        /**
         * get width of the piano key
         * @param idx index of the key
         * @return width of the key
         */
        getKeyWidth(idx) {
            if (this.isWhite(idx))
                return FieldNote.keyWidth;
            return FieldNote.keyWidth / 2;
        }
        /**
         * get height of the piano key
         * @param idx index of the key
         * @return height of the key
         */
        getKeyHeight(idx) {
            if (this.isWhite(idx))
                return FieldNote.keyHeight;
            return FieldNote.keyHeight / 2;
        }
        getKeyFreq(keyIndex) {
            return this.getKeyNoteData(keyIndex).freq;
        }
        getKeyName(keyIndex) {
            const note = this.getKeyNoteData(keyIndex);
            let name = note.prefixedName;
            if (this.nKeys_ <= FieldNote.notesPerOctave) {
                // special case: one octave
                name = note.name;
            }
            else if (this.minNote_ >= 28 && this.maxNote_ <= 63) {
                // special case: centered
                name = note.altPrefixedName || name;
            }
            return name;
        }
        getKeyNoteData(keyIndex) {
            return FieldNote.Notes[keyIndex + this.minNote_];
        }
        /**
         * get the position of the key in the piano
         * @param idx index of the key
         * @return position of the key
         */
        getPosition(idx) {
            const whiteKeyCount = idx - Math.floor((idx + 1) / FieldNote.notesPerOctave * FieldNote.blackKeysPerOctave);
            const pos = whiteKeyCount * FieldNote.keyWidth;
            if (this.isWhite(idx))
                return pos;
            return pos - (FieldNote.keyWidth / 4);
        }
        prepareNotes() {
            if (!FieldNote.Notes) {
                FieldNote.Notes = {
                    28: { name: lf("{id:note}C"), prefixedName: lf("Low C"), freq: 131 },
                    29: { name: lf("C#"), prefixedName: lf("Low C#"), freq: 139 },
                    30: { name: lf("{id:note}D"), prefixedName: lf("Low D"), freq: 147 },
                    31: { name: lf("D#"), prefixedName: lf("Low D#"), freq: 156 },
                    32: { name: lf("{id:note}E"), prefixedName: lf("Low E"), freq: 165 },
                    33: { name: lf("{id:note}F"), prefixedName: lf("Low F"), freq: 175 },
                    34: { name: lf("F#"), prefixedName: lf("Low F#"), freq: 185 },
                    35: { name: lf("{id:note}G"), prefixedName: lf("Low G"), freq: 196 },
                    36: { name: lf("G#"), prefixedName: lf("Low G#"), freq: 208 },
                    37: { name: lf("{id:note}A"), prefixedName: lf("Low A"), freq: 220 },
                    38: { name: lf("A#"), prefixedName: lf("Low A#"), freq: 233 },
                    39: { name: lf("{id:note}B"), prefixedName: lf("Low B"), freq: 247 },
                    40: { name: lf("{id:note}C"), prefixedName: lf("Middle C"), freq: 262 },
                    41: { name: lf("C#"), prefixedName: lf("Middle C#"), freq: 277 },
                    42: { name: lf("{id:note}D"), prefixedName: lf("Middle D"), freq: 294 },
                    43: { name: lf("D#"), prefixedName: lf("Middle D#"), freq: 311 },
                    44: { name: lf("{id:note}E"), prefixedName: lf("Middle E"), freq: 330 },
                    45: { name: lf("{id:note}F"), prefixedName: lf("Middle F"), freq: 349 },
                    46: { name: lf("F#"), prefixedName: lf("Middle F#"), freq: 370 },
                    47: { name: lf("{id:note}G"), prefixedName: lf("Middle G"), freq: 392 },
                    48: { name: lf("G#"), prefixedName: lf("Middle G#"), freq: 415 },
                    49: { name: lf("{id:note}A"), prefixedName: lf("Middle A"), freq: 440 },
                    50: { name: lf("A#"), prefixedName: lf("Middle A#"), freq: 466 },
                    51: { name: lf("{id:note}B"), prefixedName: lf("Middle B"), freq: 494 },
                    52: { name: lf("{id:note}C"), prefixedName: lf("Tenor C"), altPrefixedName: lf("High C"), freq: 523 },
                    53: { name: lf("C#"), prefixedName: lf("Tenor C#"), altPrefixedName: lf("High C#"), freq: 554 },
                    54: { name: lf("{id:note}D"), prefixedName: lf("Tenor D"), altPrefixedName: lf("High D"), freq: 587 },
                    55: { name: lf("D#"), prefixedName: lf("Tenor D#"), altPrefixedName: lf("High D#"), freq: 622 },
                    56: { name: lf("{id:note}E"), prefixedName: lf("Tenor E"), altPrefixedName: lf("High E"), freq: 659 },
                    57: { name: lf("{id:note}F"), prefixedName: lf("Tenor F"), altPrefixedName: lf("High F"), freq: 698 },
                    58: { name: lf("F#"), prefixedName: lf("Tenor F#"), altPrefixedName: lf("High F#"), freq: 740 },
                    59: { name: lf("{id:note}G"), prefixedName: lf("Tenor G"), altPrefixedName: lf("High G"), freq: 784 },
                    60: { name: lf("G#"), prefixedName: lf("Tenor G#"), altPrefixedName: lf("High G#"), freq: 831 },
                    61: { name: lf("{id:note}A"), prefixedName: lf("Tenor A"), altPrefixedName: lf("High A"), freq: 880 },
                    62: { name: lf("A#"), prefixedName: lf("Tenor A#"), altPrefixedName: lf("High A#"), freq: 932 },
                    63: { name: lf("{id:note}B"), prefixedName: lf("Tenor B"), altPrefixedName: lf("High B"), freq: 988 },
                    64: { name: lf("{id:note}C"), prefixedName: lf("High C"), freq: 1046 },
                    65: { name: lf("C#"), prefixedName: lf("High C#"), freq: 1109 },
                    66: { name: lf("{id:note}D"), prefixedName: lf("High D"), freq: 1175 },
                    67: { name: lf("D#"), prefixedName: lf("High D#"), freq: 1245 },
                    68: { name: lf("{id:note}E"), prefixedName: lf("High E"), freq: 1319 },
                    69: { name: lf("{id:note}F"), prefixedName: lf("High F"), freq: 1397 },
                    70: { name: lf("F#"), prefixedName: lf("High F#"), freq: 1478 },
                    71: { name: lf("{id:note}G"), prefixedName: lf("High G"), freq: 1568 },
                    72: { name: lf("G#"), prefixedName: lf("High G#"), freq: 1661 },
                    73: { name: lf("{id:note}A"), prefixedName: lf("High A"), freq: 1760 },
                    74: { name: lf("A#"), prefixedName: lf("High A#"), freq: 1865 },
                    75: { name: lf("{id:note}B"), prefixedName: lf("High B"), freq: 1976 }
                };
            }
        }
    }
    FieldNote.keyWidth = 22;
    FieldNote.keyHeight = 90;
    FieldNote.labelHeight = 24;
    FieldNote.prevNextHeight = 20;
    FieldNote.notesPerOctave = 12;
    FieldNote.blackKeysPerOctave = 5;
    pxtblockly.FieldNote = FieldNote;
    function hasOnlyOneField(block) {
        return block.inputList.length === 1 && block.inputList[0].fieldRow.length === 1;
    }
    function createStyledDiv(className, style) {
        const output = document.createElement("div");
        pxt.BrowserUtils.addClass(output, className);
        output.setAttribute("style", style.replace(/\s+/g, " "));
        return output;
    }
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/pxtblockly.d.ts" />
// common time options -- do not remove
// lf("100 ms")
// lf("200 ms")
// lf("500 ms")
// lf("1 second")
// lf("2 seconds")
// lf("5 seconds")
// lf("1 minute")
// lf("1 hour")
var pxtblockly;
(function (pxtblockly) {
    class FieldNumberDropdown extends Blockly.FieldNumberDropdown {
        constructor(value, options, opt_validator) {
            super(value, options.data, options.min, options.max, options.precision, opt_validator);
            this.isFieldCustom_ = true;
        }
        getOptions() {
            let newOptions;
            if (this.menuGenerator_) {
                newOptions = JSON.parse(this.menuGenerator_).map((x) => {
                    if (typeof x == 'object') {
                        return [pxt.Util.rlf(x[0]), x[1]];
                    }
                    else {
                        return [String(x), String(x)];
                    }
                });
            }
            return newOptions;
        }
    }
    pxtblockly.FieldNumberDropdown = FieldNumberDropdown;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/blockly.d.ts"/>
/// <reference path="../../built/pxtsim.d.ts"/>
var pxtblockly;
(function (pxtblockly) {
    class FieldPosition extends Blockly.FieldSlider {
        constructor(text, params, validator) {
            super(text, '0', '100', '1', '100', 'Value', validator);
            this.isFieldCustom_ = true;
            this.params = params;
            if (!this.params.screenHeight)
                this.params.screenHeight = 120;
            if (!this.params.screenWidth)
                this.params.screenWidth = 160;
            if (!this.params.xInputName)
                this.params.xInputName = "x";
            if (!this.params.yInputName)
                this.params.yInputName = "y";
            if (this.params.min)
                this.min_ = parseInt(this.params.min);
            if (this.params.max)
                this.max_ = parseInt(this.params.max);
        }
        showEditor_(_opt_e) {
            // Find out which field we're in (x or y) and set the appropriate max.
            const xField = this.getFieldByName(this.params.xInputName);
            if (xField === this) {
                this.max_ = this.params.screenWidth;
                this.labelText_ = this.params.xInputName;
            }
            const yField = this.getFieldByName(this.params.yInputName);
            if (yField === this) {
                this.max_ = this.params.screenHeight;
                this.labelText_ = this.params.yInputName;
            }
            // Call super to render the slider and show the dropdown div
            super.showEditor_(_opt_e);
            // Now render the screen in the dropdown div below the slider
            this.renderScreenPicker();
        }
        doValueUpdate_(value) {
            super.doValueUpdate_(value);
            if (this.resetCrosshair)
                this.resetCrosshair();
        }
        renderScreenPicker() {
            let contentDiv = Blockly.DropDownDiv.getContentDiv();
            this.selectorDiv_ = document.createElement('div');
            this.selectorDiv_.className = "blocklyCanvasOverlayOuter";
            contentDiv.appendChild(this.selectorDiv_);
            const canvasOverlayDiv = document.createElement('div');
            canvasOverlayDiv.className = 'blocklyCanvasOverlayDiv';
            this.selectorDiv_.appendChild(canvasOverlayDiv);
            const crossX = document.createElement('div');
            crossX.className = 'cross-x';
            canvasOverlayDiv.appendChild(crossX);
            const crossY = document.createElement('div');
            crossY.className = 'cross-y';
            canvasOverlayDiv.appendChild(crossY);
            const label = document.createElement('div');
            label.className = 'label';
            canvasOverlayDiv.appendChild(label);
            const width = this.params.screenWidth * 1.5;
            const height = this.params.screenHeight * 1.5;
            canvasOverlayDiv.style.height = height + 'px';
            canvasOverlayDiv.style.width = width + 'px';
            // The slider is set to a fixed width, so we have to resize it
            // to match the screen size
            const slider = contentDiv.getElementsByClassName("goog-slider-horizontal")[0];
            if (slider) {
                slider.style.width = width + "px";
                // Because we resized the slider, we need to update the handle position. The closure
                // slider won't update unless the value changes so change it and un-change it
                const value = parseFloat(this.getValue());
                if (!isNaN(value) && value > this.getMin()) {
                    this.setValue((value - 1) + "");
                    this.setValue(value + "");
                }
            }
            const setPos = (x, y) => {
                x = Math.round(Math.max(0, Math.min(width, x)));
                y = Math.round(Math.max(0, Math.min(height, y)));
                crossX.style.top = y + 'px';
                crossY.style.left = x + 'px';
                x = Math.round(Math.max(0, Math.min(this.params.screenWidth, x / width * this.params.screenWidth)));
                y = Math.round(Math.max(0, Math.min(this.params.screenHeight, y / height * this.params.screenHeight)));
                // Check to see if label exists instead of showing NaN
                if (isNaN(x)) {
                    label.textContent = `${this.params.yInputName}=${y}`;
                }
                else if (isNaN(y)) {
                    label.textContent = `${this.params.xInputName}=${x}`;
                }
                else {
                    label.textContent = `${this.params.xInputName}=${x} ${this.params.yInputName}=${y}`;
                }
                // Position the label so that it doesn't go outside the screen bounds
                const bb = label.getBoundingClientRect();
                if (x > this.params.screenWidth / 2) {
                    label.style.left = (x * (width / this.params.screenWidth) - bb.width - 8) + 'px';
                }
                else {
                    label.style.left = (x * (width / this.params.screenWidth) + 4) + 'px';
                }
                if (y > this.params.screenHeight / 2) {
                    label.style.top = (y * (height / this.params.screenHeight) - bb.height - 6) + "px";
                }
                else {
                    label.style.top = (y * (height / this.params.screenHeight)) + 'px';
                }
            };
            // Position initial crossX and crossY
            this.resetCrosshair = () => {
                const { currentX, currentY } = this.getXY();
                setPos(currentX / this.params.screenWidth * width, currentY / this.params.screenHeight * height);
            };
            this.resetCrosshair();
            Blockly.bindEvent_(this.selectorDiv_, 'mousemove', this, (e) => {
                const bb = canvasOverlayDiv.getBoundingClientRect();
                const x = e.clientX - bb.left;
                const y = e.clientY - bb.top;
                setPos(x, y);
            });
            Blockly.bindEvent_(this.selectorDiv_, 'mouseleave', this, this.resetCrosshair);
            Blockly.bindEvent_(this.selectorDiv_, 'click', this, (e) => {
                const bb = canvasOverlayDiv.getBoundingClientRect();
                const x = e.clientX - bb.left;
                const y = e.clientY - bb.top;
                const normalizedX = Math.round(x / width * this.params.screenWidth);
                const normalizedY = Math.round(y / height * this.params.screenHeight);
                this.close();
                this.setXY(normalizedX, normalizedY);
            });
        }
        resizeHandler() {
            this.close();
        }
        setXY(x, y) {
            const xField = this.getFieldByName(this.params.xInputName);
            if (xField && typeof xField.getValue() == "number") {
                xField.setValue(String(x));
            }
            const yField = this.getFieldByName(this.params.yInputName);
            if (yField && typeof yField.getValue() == "number") {
                yField.setValue(String(y));
            }
        }
        getFieldByName(name) {
            const parentBlock = this.sourceBlock_.parentBlock_;
            if (!parentBlock)
                return undefined; // warn
            for (let i = 0; i < parentBlock.inputList.length; i++) {
                const input = parentBlock.inputList[i];
                if (input.name === name) {
                    return this.getTargetField(input);
                }
            }
            return undefined;
        }
        getXY() {
            let currentX;
            let currentY;
            const xField = this.getFieldByName(this.params.xInputName);
            if (xField)
                currentX = xField.getValue();
            const yField = this.getFieldByName(this.params.yInputName);
            if (yField)
                currentY = yField.getValue();
            return { currentX: parseInt(currentX), currentY: parseInt(currentY) };
        }
        getTargetField(input) {
            const targetBlock = input.connection.targetBlock();
            if (!targetBlock)
                return null;
            const targetInput = targetBlock.inputList[0];
            if (!targetInput)
                return null;
            const targetField = targetInput.fieldRow[0];
            return targetField;
        }
        widgetDispose_() {
            const that = this;
            Blockly.FieldNumber.superClass_.widgetDispose_.call(that);
            that.close(true);
        }
        close(skipWidget) {
            if (!skipWidget) {
                Blockly.WidgetDiv.hideIfOwner(this);
                Blockly.DropDownDiv.hideIfOwner(this);
            }
            // remove resize listener
            window.removeEventListener("resize", this.resizeHandler);
            this.resetCrosshair = undefined;
            // Destroy the selector div
            if (!this.selectorDiv_)
                return;
            goog.dom.removeNode(this.selectorDiv_);
            this.selectorDiv_ = undefined;
        }
    }
    pxtblockly.FieldPosition = FieldPosition;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/pxtblockly.d.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldProcedure extends Blockly.FieldDropdown {
        constructor(funcname, opt_validator) {
            super([["Temp", "Temp"]], opt_validator);
            this.setValue(funcname || '');
        }
        getOptions() {
            return this.dropdownCreate();
        }
        ;
        init() {
            if (this.fieldGroup_) {
                // Dropdown has already been initialized once.
                return;
            }
            super.init.call(this);
        }
        ;
        setSourceBlock(block) {
            goog.asserts.assert(!block.isShadow(), 'Procedure fields are not allowed to exist on shadow blocks.');
            super.setSourceBlock.call(this, block);
        }
        ;
        /**
         * Return a sorted list of variable names for procedure dropdown menus.
         * Include a special option at the end for creating a new function name.
         * @return {!Array.<string>} Array of procedure names.
         * @this {pxtblockly.FieldProcedure}
         */
        dropdownCreate() {
            let functionList = [];
            if (this.sourceBlock_ && this.sourceBlock_.workspace) {
                let blocks = this.sourceBlock_.workspace.getAllBlocks(false);
                // Iterate through every block and check the name.
                for (let i = 0; i < blocks.length; i++) {
                    if (blocks[i].getProcedureDef) {
                        let procName = blocks[i].getProcedureDef();
                        functionList.push(procName[0]);
                    }
                }
            }
            // Ensure that the currently selected variable is an option.
            let name = this.getValue();
            if (name && functionList.indexOf(name) == -1) {
                functionList.push(name);
            }
            functionList.sort(goog.string.caseInsensitiveCompare);
            if (!functionList.length) {
                // Add temporary list item so the dropdown doesn't break
                functionList.push("Temp");
            }
            // Variables are not language-specific, use the name as both the user-facing
            // text and the internal representation.
            let options = [];
            for (let i = 0; i < functionList.length; i++) {
                options[i] = [functionList[i], functionList[i]];
            }
            return options;
        }
        onItemSelected(menu, menuItem) {
            let itemText = menuItem.getValue();
            if (itemText !== null) {
                this.setValue(itemText);
            }
        }
    }
    pxtblockly.FieldProcedure = FieldProcedure;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/blockly.d.ts"/>
/// <reference path="../../built/pxtsim.d.ts"/>
var pxtblockly;
(function (pxtblockly) {
    class FieldProtractor extends Blockly.FieldSlider {
        /**
         * Class for a color wheel field.
         * @param {number|string} value The initial content of the field.
         * @param {Function=} opt_validator An optional function that is called
         *     to validate any constraints on what the user entered.  Takes the new
         *     text as an argument and returns either the accepted text, a replacement
         *     text, or null to abort the change.
         * @extends {Blockly.FieldNumber}
         * @constructor
         */
        constructor(value_, params, opt_validator) {
            super(String(value_), '0', '180', '1', '15', lf("Angle"), opt_validator);
            this.isFieldCustom_ = true;
            this.params = params;
        }
        createLabelDom_(labelText) {
            const labelContainer = document.createElement('div');
            this.circleSVG = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            pxsim.svg.hydrate(this.circleSVG, {
                viewBox: "0 0 200 100",
                width: "170"
            });
            labelContainer.appendChild(this.circleSVG);
            const outerCircle = pxsim.svg.child(this.circleSVG, "circle", {
                'stroke-dasharray': '565.48', 'stroke-dashoffset': '0',
                'cx': 100, 'cy': 100, 'r': '90', 'style': `fill:transparent; transition: stroke-dashoffset 0.1s linear;`,
                'stroke': '#a8aaa8', 'stroke-width': '1rem'
            });
            this.circleBar = pxsim.svg.child(this.circleSVG, "circle", {
                'stroke-dasharray': '565.48', 'stroke-dashoffset': '0',
                'cx': 100, 'cy': 100, 'r': '90', 'style': `fill:transparent; transition: stroke-dashoffset 0.1s linear;`,
                'stroke': '#f12a21', 'stroke-width': '1rem'
            });
            this.reporter = pxsim.svg.child(this.circleSVG, "text", {
                'x': 100, 'y': 80,
                'text-anchor': 'middle', 'dominant-baseline': 'middle',
                'style': 'font-size: 50px',
                'class': 'sim-text inverted number'
            });
            // labelContainer.setAttribute('class', 'blocklyFieldSliderLabel');
            const readout = document.createElement('span');
            readout.setAttribute('class', 'blocklyFieldSliderReadout');
            return [labelContainer, readout];
        }
        ;
        setReadout_(readout, value) {
            this.updateAngle(parseFloat(value));
            // Update reporter
            this.reporter.textContent = `${value}°`;
        }
        updateAngle(angle) {
            angle = Math.max(0, Math.min(180, angle));
            const radius = 90;
            const pct = (180 - angle) / 180 * Math.PI * radius;
            this.circleBar.setAttribute('stroke-dashoffset', `${pct}`);
        }
    }
    pxtblockly.FieldProtractor = FieldProtractor;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../built/pxtlib.d.ts" />
/// <reference path="./field_base.ts" />
var pxtblockly;
(function (pxtblockly) {
    var svg = pxt.svgUtil;
    const MUSIC_ICON_WIDTH = 20;
    const TOTAL_WIDTH = 160;
    const TOTAL_HEIGHT = 40;
    const X_PADDING = 5;
    const Y_PADDING = 4;
    const PREVIEW_WIDTH = TOTAL_WIDTH - X_PADDING * 5 - MUSIC_ICON_WIDTH;
    class FieldSoundEffect extends pxtblockly.FieldBase {
        constructor() {
            super(...arguments);
            this.registeredChangeListener = false;
            this.onWorkspaceChange = (ev) => {
                if (ev.type !== Blockly.Events.CHANGE)
                    return;
                const block = this.sourceBlock_.workspace.getBlockById(ev.blockId);
                if (!block || block !== this.sourceBlock_ && block.parentBlock_ !== this.sourceBlock_)
                    return;
                this.redrawPreview();
            };
        }
        onInit() {
            if (!this.options)
                this.options = {};
            if (!this.options.durationInputName)
                this.options.durationInputName = "duration";
            if (!this.options.startFrequencyInputName)
                this.options.startFrequencyInputName = "startFrequency";
            if (!this.options.endFrequencyInputName)
                this.options.endFrequencyInputName = "endFrequency";
            if (!this.options.startVolumeInputName)
                this.options.startVolumeInputName = "startVolume";
            if (!this.options.endVolumeInputName)
                this.options.endVolumeInputName = "endVolume";
            if (!this.options.waveFieldName)
                this.options.waveFieldName = "waveShape";
            if (!this.options.interpolationFieldName)
                this.options.interpolationFieldName = "interpolation";
            if (!this.options.effectFieldName)
                this.options.effectFieldName = "effect";
            this.redrawPreview();
            if (this.sourceBlock_.workspace) {
                this.workspace = this.sourceBlock_.workspace;
                if (!this.sourceBlock_.isShadow() && !this.sourceBlock_.isInsertionMarker()) {
                    this.registeredChangeListener = true;
                    this.workspace.addChangeListener(this.onWorkspaceChange);
                }
            }
        }
        onDispose() {
            if (this.workspace && this.registeredChangeListener) {
                this.workspace.removeChangeListener(this.onWorkspaceChange);
                this.registeredChangeListener = false;
            }
        }
        onValueChanged(newValue) {
            return newValue;
        }
        redrawPreview() {
            if (!this.fieldGroup_)
                return;
            if (this.drawnSound) {
                const current = this.readCurrentSound();
                if (current.startFrequency === this.drawnSound.startFrequency &&
                    current.endFrequency === this.drawnSound.endFrequency &&
                    current.startVolume === this.drawnSound.startVolume &&
                    current.endVolume === this.drawnSound.endVolume &&
                    current.wave === this.drawnSound.wave &&
                    current.interpolation === this.drawnSound.interpolation) {
                    return;
                }
            }
            pxsim.U.clear(this.fieldGroup_);
            const bg = new svg.Rect()
                .at(X_PADDING, Y_PADDING)
                .size(TOTAL_WIDTH, TOTAL_HEIGHT)
                .setClass("blocklySpriteField")
                .stroke("#fff", 1)
                .fill("#dedede")
                .corner(TOTAL_HEIGHT / 2);
            const clipPathId = "preview-clip-" + pxt.U.guidGen();
            const clip = new svg.ClipPath()
                .id(clipPathId)
                .clipPathUnits(false);
            const clipRect = new svg.Rect()
                .size(PREVIEW_WIDTH, TOTAL_HEIGHT)
                .fill("#FFF")
                .at(0, 0);
            clip.appendChild(clipRect);
            this.drawnSound = this.readCurrentSound();
            const path = new svg.Path()
                .stroke("grey", 2)
                .fill("none")
                .setD(pxt.assets.renderSoundPath(this.drawnSound, TOTAL_WIDTH - X_PADDING * 4 - MUSIC_ICON_WIDTH, TOTAL_HEIGHT - Y_PADDING * 2))
                .clipPath("url('#" + clipPathId + "')");
            const g = new svg.Group()
                .translate(MUSIC_ICON_WIDTH + X_PADDING * 3, Y_PADDING + 3);
            g.appendChild(clip);
            g.appendChild(path);
            const musicIcon = new svg.Text("\uf001")
                .appendClass("melody-editor-field-icon")
                .setAttribute("alignment-baseline", "middle")
                .anchor("middle")
                .at(X_PADDING * 2 + MUSIC_ICON_WIDTH / 2, TOTAL_HEIGHT / 2 + 4);
            this.fieldGroup_.appendChild(bg.el);
            this.fieldGroup_.appendChild(musicIcon.el);
            this.fieldGroup_.appendChild(g.el);
        }
        showEditor_() {
            const initialSound = this.readCurrentSound();
            Blockly.Events.disable();
            let bbox;
            // This is due to the changes in https://github.com/microsoft/pxt-blockly/pull/289
            // which caused the widgetdiv to jump around if any fields underneath changed size
            let widgetOwner = {
                getScaledBBox: () => bbox
            };
            Blockly.WidgetDiv.show(widgetOwner, this.sourceBlock_.RTL, () => {
                fv.hide();
                widgetDiv.classList.remove("sound-effect-editor-widget");
                widgetDiv.style.transform = "";
                widgetDiv.style.position = "";
                widgetDiv.style.left = "";
                widgetDiv.style.top = "";
                widgetDiv.style.width = "";
                widgetDiv.style.height = "";
                widgetDiv.style.opacity = "";
                widgetDiv.style.transition = "";
                Blockly.Events.enable();
                Blockly.Events.setGroup(true);
                this.fireNumberInputUpdate(this.options.durationInputName, initialSound.duration);
                this.fireNumberInputUpdate(this.options.startFrequencyInputName, initialSound.startFrequency);
                this.fireNumberInputUpdate(this.options.endFrequencyInputName, initialSound.endFrequency);
                this.fireNumberInputUpdate(this.options.startVolumeInputName, initialSound.startVolume);
                this.fireNumberInputUpdate(this.options.endVolumeInputName, initialSound.endVolume);
                this.fireFieldDropdownUpdate(this.options.waveFieldName, waveformMapping[initialSound.wave]);
                this.fireFieldDropdownUpdate(this.options.interpolationFieldName, interpolationMapping[initialSound.interpolation]);
                this.fireFieldDropdownUpdate(this.options.effectFieldName, effectMapping[initialSound.effect]);
                Blockly.Events.setGroup(false);
                if (this.mostRecentValue)
                    this.setBlockData(JSON.stringify(this.mostRecentValue));
            });
            const widgetDiv = Blockly.WidgetDiv.DIV;
            const opts = {
                onClose: () => {
                    fv.hide();
                    Blockly.WidgetDiv.hideIfOwner(widgetOwner);
                },
                onSoundChange: (newSound) => {
                    this.mostRecentValue = newSound;
                    this.updateSiblingBlocks(newSound);
                    this.redrawPreview();
                },
                initialSound: initialSound
            };
            const fv = pxt.react.getFieldEditorView("soundeffect-editor", initialSound, opts, widgetDiv);
            const block = this.sourceBlock_;
            const bounds = block.getBoundingRectangle();
            const coord = pxtblockly.workspaceToScreenCoordinates(block.workspace, new Blockly.utils.Coordinate(bounds.right, bounds.top));
            const animationDistance = 20;
            const left = coord.x + 20;
            const top = coord.y - animationDistance;
            widgetDiv.style.opacity = "0";
            widgetDiv.classList.add("sound-effect-editor-widget");
            widgetDiv.style.position = "absolute";
            widgetDiv.style.left = left + "px";
            widgetDiv.style.top = top + "px";
            widgetDiv.style.width = "30rem";
            widgetDiv.style.height = "40rem";
            widgetDiv.style.display = "block";
            widgetDiv.style.transition = "transform 0.25s ease 0s, opacity 0.25s ease 0s";
            widgetDiv.style.borderRadius = "";
            fv.onHide(() => {
                // do nothing
            });
            fv.show();
            const divBounds = widgetDiv.getBoundingClientRect();
            const injectDivBounds = block.workspace.getInjectionDiv().getBoundingClientRect();
            if (divBounds.height > injectDivBounds.height) {
                widgetDiv.style.height = "";
                widgetDiv.style.top = `calc(1rem - ${animationDistance}px)`;
                widgetDiv.style.bottom = `calc(1rem + ${animationDistance}px)`;
            }
            else {
                if (divBounds.bottom > injectDivBounds.bottom || divBounds.top < injectDivBounds.top) {
                    // This editor is pretty tall, so just center vertically on the inject div
                    widgetDiv.style.top = (injectDivBounds.top + (injectDivBounds.height / 2) - (divBounds.height / 2)) - animationDistance + "px";
                }
            }
            const toolboxWidth = block.workspace.getToolbox().getWidth();
            if (divBounds.width > injectDivBounds.width - toolboxWidth) {
                widgetDiv.style.width = "";
                widgetDiv.style.left = "1rem";
                widgetDiv.style.right = "1rem";
            }
            else {
                // Check to see if we are bleeding off the right side of the canvas
                if (divBounds.left + divBounds.width >= injectDivBounds.right) {
                    // If so, try and place to the left of the block instead of the right
                    const blockLeft = pxtblockly.workspaceToScreenCoordinates(block.workspace, new Blockly.utils.Coordinate(bounds.left, bounds.top));
                    const workspaceLeft = injectDivBounds.left + toolboxWidth;
                    if (blockLeft.x - divBounds.width - 20 > workspaceLeft) {
                        widgetDiv.style.left = (blockLeft.x - divBounds.width - 20) + "px";
                    }
                    else {
                        // As a last resort, just center on the inject div
                        widgetDiv.style.left = (workspaceLeft + ((injectDivBounds.width - toolboxWidth) / 2) - divBounds.width / 2) + "px";
                    }
                }
            }
            const finalDimensions = widgetDiv.getBoundingClientRect();
            bbox = new Blockly.utils.Rect(finalDimensions.top, finalDimensions.bottom, finalDimensions.left, finalDimensions.right);
            requestAnimationFrame(() => {
                widgetDiv.style.opacity = "1";
                widgetDiv.style.transform = `translateY(${animationDistance}px)`;
            });
        }
        render_() {
            super.render_();
            this.size_.height = TOTAL_HEIGHT + Y_PADDING * 2;
            this.size_.width = TOTAL_WIDTH + X_PADDING;
        }
        updateSiblingBlocks(sound) {
            this.setNumberInputValue(this.options.durationInputName, sound.duration);
            this.setNumberInputValue(this.options.startFrequencyInputName, sound.startFrequency);
            this.setNumberInputValue(this.options.endFrequencyInputName, sound.endFrequency);
            this.setNumberInputValue(this.options.startVolumeInputName, sound.startVolume);
            this.setNumberInputValue(this.options.endVolumeInputName, sound.endVolume);
            this.setFieldDropdownValue(this.options.waveFieldName, waveformMapping[sound.wave]);
            this.setFieldDropdownValue(this.options.interpolationFieldName, interpolationMapping[sound.interpolation]);
            this.setFieldDropdownValue(this.options.effectFieldName, effectMapping[sound.effect]);
        }
        setNumberInputValue(name, value) {
            const block = this.getSiblingBlock(name) || this.getSiblingBlock(name, true);
            if (!block)
                return;
            if (block.type === "math_number" || block.type === "math_integer" || block.type === "math_whole_number") {
                block.setFieldValue(Math.round(value), "NUM");
            }
            else if (block.type === "math_number_minmax") {
                block.setFieldValue(Math.round(value), "SLIDER");
            }
        }
        getNumberInputValue(name, defaultValue) {
            const block = this.getSiblingBlock(name) || this.getSiblingBlock(name, true);
            if (!block)
                return defaultValue;
            if (block.type === "math_number" || block.type === "math_integer" || block.type === "math_whole_number") {
                return parseInt(block.getFieldValue("NUM") + "");
            }
            else if (block.type === "math_number_minmax") {
                return parseInt(block.getFieldValue("SLIDER") + "");
            }
            return defaultValue;
        }
        fireNumberInputUpdate(name, oldValue) {
            const block = this.getSiblingBlock(name) || this.getSiblingBlock(name, true);
            if (!block)
                return;
            let fieldName;
            if (block.type === "math_number" || block.type === "math_integer" || block.type === "math_whole_number") {
                fieldName = "NUM";
            }
            else if (block.type === "math_number_minmax") {
                fieldName = "SLIDER";
            }
            if (!fieldName)
                return;
            Blockly.Events.fire(new Blockly.Events.Change(block, "field", fieldName, oldValue, this.getNumberInputValue(name, oldValue)));
        }
        setFieldDropdownValue(name, value) {
            const field = this.getSiblingField(name) || this.getSiblingField(name, true);
            if (!field)
                return;
            field.setValue(value);
        }
        getFieldDropdownValue(name) {
            const field = this.getSiblingField(name) || this.getSiblingField(name, true);
            if (!field)
                return undefined;
            return field.getValue();
        }
        fireFieldDropdownUpdate(name, oldValue) {
            const field = this.getSiblingField(name) || this.getSiblingField(name, true);
            if (!field)
                return;
            Blockly.Events.fire(new Blockly.Events.Change(field.sourceBlock_, "field", field.name, oldValue, this.getFieldDropdownValue(name)));
        }
        readCurrentSound() {
            const savedSound = this.readBlockDataSound();
            return {
                duration: this.getNumberInputValue(this.options.durationInputName, savedSound.duration),
                startFrequency: this.getNumberInputValue(this.options.startFrequencyInputName, savedSound.startFrequency),
                endFrequency: this.getNumberInputValue(this.options.endFrequencyInputName, savedSound.endFrequency),
                startVolume: this.getNumberInputValue(this.options.startVolumeInputName, savedSound.startVolume),
                endVolume: this.getNumberInputValue(this.options.endVolumeInputName, savedSound.endVolume),
                wave: reverseLookup(waveformMapping, this.getFieldDropdownValue(this.options.waveFieldName)) || savedSound.wave,
                interpolation: reverseLookup(interpolationMapping, this.getFieldDropdownValue(this.options.interpolationFieldName)) || savedSound.interpolation,
                effect: reverseLookup(effectMapping, this.getFieldDropdownValue(this.options.effectFieldName)) || savedSound.effect,
            };
        }
        // This stores the values of the fields in case a block (e.g. a variable) is placed in one
        // of the inputs.
        readBlockDataSound() {
            const data = this.getBlockData();
            let sound;
            try {
                sound = JSON.parse(data);
            }
            catch (e) {
                sound = {
                    duration: 1000,
                    startFrequency: 100,
                    endFrequency: 4800,
                    startVolume: 100,
                    endVolume: 0,
                    wave: "sine",
                    interpolation: "linear",
                    effect: "none"
                };
            }
            return sound;
        }
    }
    pxtblockly.FieldSoundEffect = FieldSoundEffect;
    const waveformMapping = {
        "sine": "WaveShape.Sine",
        "square": "WaveShape.Square",
        "sawtooth": "WaveShape.Sawtooth",
        "triangle": "WaveShape.Triangle",
        "noise": "WaveShape.Noise",
    };
    const effectMapping = {
        "none": "SoundExpressionEffect.None",
        "vibrato": "SoundExpressionEffect.Vibrato",
        "tremolo": "SoundExpressionEffect.Tremolo",
        "warble": "SoundExpressionEffect.Warble",
    };
    const interpolationMapping = {
        "linear": "InterpolationCurve.Linear",
        "curve": "InterpolationCurve.Curve",
        "logarithmic": "InterpolationCurve.Logarithmic",
    };
    function reverseLookup(map, value) {
        return Object.keys(map).find(k => map[k] === value);
    }
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/blockly.d.ts"/>
/// <reference path="../../built/pxtsim.d.ts"/>
var pxtblockly;
(function (pxtblockly) {
    class FieldSpeed extends Blockly.FieldSlider {
        /**
         * Class for a color wheel field.
         * @param {number|string} value The initial content of the field.
         * @param {Function=} opt_validator An optional function that is called
         *     to validate any constraints on what the user entered.  Takes the new
         *     text as an argument and returns either the accepted text, a replacement
         *     text, or null to abort the change.
         * @extends {Blockly.FieldNumber}
         * @constructor
         */
        constructor(value_, params, opt_validator) {
            super(String(value_), '-100', '100', '1', '10', 'Speed', opt_validator);
            this.isFieldCustom_ = true;
            this.params = params;
            if (this.params['min'])
                this.min_ = parseFloat(this.params.min);
            if (this.params['max'])
                this.max_ = parseFloat(this.params.max);
            if (this.params['label'])
                this.labelText_ = this.params.label;
            if (!this.params.format)
                this.params.format = "{0}%";
        }
        createLabelDom_(labelText) {
            const labelContainer = document.createElement('div');
            this.speedSVG = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            pxsim.svg.hydrate(this.speedSVG, {
                viewBox: "0 0 200 100",
                width: "170"
            });
            labelContainer.appendChild(this.speedSVG);
            const outerCircle = pxsim.svg.child(this.speedSVG, "circle", {
                'stroke-dasharray': '565.48', 'stroke-dashoffset': '0',
                'cx': 100, 'cy': 100, 'r': '90', 'style': `fill:transparent; transition: stroke-dashoffset 0.1s linear;`,
                'stroke': '#a8aaa8', 'stroke-width': '1rem'
            });
            this.circleBar = pxsim.svg.child(this.speedSVG, "circle", {
                'stroke-dasharray': '565.48', 'stroke-dashoffset': '0',
                'cx': 100, 'cy': 100, 'r': '90', 'style': `fill:transparent; transition: stroke-dashoffset 0.1s linear;`,
                'stroke': '#f12a21', 'stroke-width': '1rem'
            });
            this.reporter = pxsim.svg.child(this.speedSVG, "text", {
                'x': 100, 'y': 80,
                'text-anchor': 'middle', 'dominant-baseline': 'middle',
                'style': `font-size: ${Math.max(14, 50 - 5 * (this.params.format.length - 4))}px`,
                'class': 'sim-text inverted number'
            });
            // labelContainer.setAttribute('class', 'blocklyFieldSliderLabel');
            const readout = document.createElement('span');
            readout.setAttribute('class', 'blocklyFieldSliderReadout');
            // var label = document.createElement('span');
            // label.setAttribute('class', 'blocklyFieldSliderLabelText');
            // label.innerHTML = labelText;
            // labelContainer.appendChild(label);
            // labelContainer.appendChild(readout);
            return [labelContainer, readout];
        }
        ;
        setReadout_(readout, value) {
            this.updateSpeed(parseFloat(value));
            // Update reporter
            this.reporter.textContent = ts.pxtc.U.rlf(this.params.format, value);
        }
        updateSpeed(speed) {
            let sign = this.sign(speed);
            speed = (Math.abs(speed) / 100 * 50) + 50;
            if (sign == -1)
                speed = 50 - speed;
            let c = Math.PI * (90 * 2);
            let pct = ((100 - speed) / 100) * c;
            this.circleBar.setAttribute('stroke-dashoffset', `${pct}`);
        }
        // A re-implementation of Math.sign (since IE11 doesn't support it)
        sign(num) {
            return num ? num < 0 ? -1 : 1 : 0;
        }
    }
    pxtblockly.FieldSpeed = FieldSpeed;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../built/pxtlib.d.ts" />
/// <reference path="./field_asset.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldSpriteEditor extends pxtblockly.FieldAssetEditor {
        getAssetType() {
            return "image" /* Image */;
        }
        createNewAsset(text) {
            const project = pxt.react.getTilemapProject();
            if (text) {
                const asset = pxt.lookupProjectAssetByTSReference(text, project);
                if (asset)
                    return asset;
            }
            if (this.getBlockData()) {
                return project.lookupAsset("image" /* Image */, this.getBlockData());
            }
            const bmp = text ? pxt.sprite.imageLiteralToBitmap(text) : new pxt.sprite.Bitmap(this.params.initWidth, this.params.initHeight);
            if (!bmp) {
                this.isGreyBlock = true;
                this.valueText = text;
                return undefined;
            }
            const data = bmp.data();
            const newAsset = {
                internalID: -1,
                id: this.sourceBlock_.id,
                type: "image" /* Image */,
                jresData: pxt.sprite.base64EncodeBitmap(data),
                meta: {},
                bitmap: data
            };
            return newAsset;
        }
        getValueText() {
            if (this.asset && !this.isTemporaryAsset()) {
                return pxt.getTSReferenceForAsset(this.asset);
            }
            return pxt.sprite.bitmapToImageLiteral(this.asset && pxt.sprite.Bitmap.fromData(this.asset.bitmap), "typescript" /* TypeScript */);
        }
        parseFieldOptions(opts) {
            return parseFieldOptions(opts);
        }
    }
    pxtblockly.FieldSpriteEditor = FieldSpriteEditor;
    function parseFieldOptions(opts) {
        // NOTE: This implementation is duplicated in pxtcompiler/emitter/service.ts
        // TODO: Refactor to share implementation.
        const parsed = {
            initColor: 1,
            initWidth: 16,
            initHeight: 16,
            disableResize: false,
            lightMode: false,
        };
        if (!opts) {
            return parsed;
        }
        parsed.lightMode = opts.lightMode;
        if (opts.sizes) {
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
                const screenSize = pxt.appTarget.runtime && pxt.appTarget.runtime.screenSize;
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
        if (opts.filter) {
            parsed.filter = opts.filter;
        }
        if (opts.disableResize) {
            parsed.disableResize = opts.disableResize.toLowerCase() === "true" || opts.disableResize === "1";
        }
        parsed.initColor = withDefault(opts.initColor, parsed.initColor);
        parsed.initWidth = withDefault(opts.initWidth, parsed.initWidth);
        parsed.initHeight = withDefault(opts.initHeight, parsed.initHeight);
        return parsed;
        function withDefault(raw, def) {
            const res = parseInt(raw);
            if (isNaN(res)) {
                return def;
            }
            return res;
        }
    }
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/pxtblockly.d.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldStyledLabel extends Blockly.FieldLabel {
        constructor(value, options, opt_validator) {
            super(value, getClass(options));
            this.isFieldCustom_ = true;
        }
    }
    pxtblockly.FieldStyledLabel = FieldStyledLabel;
    function getClass(options) {
        if (options) {
            if (options.bold && options.italics) {
                return 'blocklyBoldItalicizedText';
            }
            else if (options.bold) {
                return 'blocklyBoldText';
            }
            else if (options.italics) {
                return 'blocklyItalicizedText';
            }
        }
        return undefined;
    }
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/pxtblockly.d.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldTextInput extends Blockly.FieldTextInput {
        constructor(value, options, opt_validator) {
            super(value, opt_validator);
            this.isFieldCustom_ = true;
        }
    }
    pxtblockly.FieldTextInput = FieldTextInput;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../built/pxtlib.d.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldTilemap extends pxtblockly.FieldAssetEditor {
        getInitText() {
            return this.initText;
        }
        getTileset() {
            var _a;
            return (_a = this.asset) === null || _a === void 0 ? void 0 : _a.data.tileset;
        }
        getAssetType() {
            return "tilemap" /* Tilemap */;
        }
        createNewAsset(newText = "") {
            if (newText) {
                // backticks are escaped inside markdown content
                newText = newText.replace(/&#96;/g, "`");
            }
            const project = pxt.react.getTilemapProject();
            const existing = pxt.lookupProjectAssetByTSReference(newText, project);
            if (existing)
                return existing;
            const tilemap = pxt.sprite.decodeTilemap(newText, "typescript", project) || project.blankTilemap(this.params.tileWidth, this.params.initWidth, this.params.initHeight);
            let newAsset;
            // Ignore invalid bitmaps
            if (checkTilemap(tilemap)) {
                this.initText = newText;
                this.isGreyBlock = false;
                const [name] = project.createNewTilemapFromData(tilemap);
                newAsset = project.getTilemap(name);
            }
            else if (newText.trim()) {
                this.isGreyBlock = true;
                this.valueText = newText;
            }
            return newAsset;
        }
        onEditorClose(newValue) {
            pxt.sprite.updateTilemapReferencesFromResult(pxt.react.getTilemapProject(), newValue);
        }
        getValueText() {
            if (this.isGreyBlock)
                return pxt.Util.htmlUnescape(this.valueText);
            if (this.asset) {
                return pxt.getTSReferenceForAsset(this.asset);
            }
            return this.getInitText();
        }
        parseFieldOptions(opts) {
            return parseFieldOptions(opts);
        }
    }
    pxtblockly.FieldTilemap = FieldTilemap;
    function parseFieldOptions(opts) {
        const parsed = {
            initWidth: 16,
            initHeight: 16,
            disableResize: false,
            tileWidth: 16,
            lightMode: false
        };
        if (!opts) {
            return parsed;
        }
        parsed.lightMode = opts.lightMode;
        if (opts.filter) {
            parsed.filter = opts.filter;
        }
        if (opts.tileWidth) {
            if (typeof opts.tileWidth === "number") {
                switch (opts.tileWidth) {
                    case 8:
                        parsed.tileWidth = 8;
                        break;
                    case 16:
                        parsed.tileWidth = 16;
                        break;
                    case 32:
                        parsed.tileWidth = 32;
                        break;
                }
            }
            else {
                const tw = opts.tileWidth.trim().toLowerCase();
                switch (tw) {
                    case "8":
                    case "eight":
                        parsed.tileWidth = 8;
                        break;
                    case "16":
                    case "sixteen":
                        parsed.tileWidth = 16;
                        break;
                    case "32":
                    case "thirtytwo":
                        parsed.tileWidth = 32;
                        break;
                }
            }
        }
        parsed.initWidth = withDefault(opts.initWidth, parsed.initWidth);
        parsed.initHeight = withDefault(opts.initHeight, parsed.initHeight);
        return parsed;
        function withDefault(raw, def) {
            const res = parseInt(raw);
            if (isNaN(res)) {
                return def;
            }
            return res;
        }
    }
    function checkTilemap(tilemap) {
        if (!tilemap || !tilemap.tilemap || !tilemap.tilemap.width || !tilemap.tilemap.height)
            return false;
        if (!tilemap.layers || tilemap.layers.width !== tilemap.tilemap.width || tilemap.layers.height !== tilemap.tilemap.height)
            return false;
        if (!tilemap.tileset)
            return false;
        return true;
    }
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../built/pxtlib.d.ts" />
var pxtblockly;
(function (pxtblockly) {
    const PREVIEW_SIDE_LENGTH = 32;
    class FieldTileset extends pxtblockly.FieldImages {
        constructor(text, options, validator) {
            super(text, options, validator);
            this.isFieldCustom_ = true;
            this.menuGenerator_ = () => {
                var _a, _b;
                if (((_a = this.sourceBlock_) === null || _a === void 0 ? void 0 : _a.workspace) && pxtblockly.needsTilemapUpgrade((_b = this.sourceBlock_) === null || _b === void 0 ? void 0 : _b.workspace)) {
                    return [constructTransparentTile()];
                }
                return FieldTileset.getReferencedTiles(this.sourceBlock_.workspace);
            };
            this.assetChangeListener = () => {
                this.doValueUpdate_(this.getValue());
                this.forceRerender();
            };
            this.blocksInfo = options.blocksInfo;
        }
        static getReferencedTiles(workspace) {
            const project = pxt.react.getTilemapProject();
            if (project.revision() !== FieldTileset.cachedRevision || workspace.id != FieldTileset.cachedWorkspaceId) {
                FieldTileset.cachedRevision = project.revision();
                FieldTileset.cachedWorkspaceId = workspace.id;
                const references = pxtblockly.getAllReferencedTiles(workspace);
                const supportedTileWidths = [16, 8, 32];
                for (const width of supportedTileWidths) {
                    const projectTiles = project.getProjectTiles(width, width === 16);
                    if (!projectTiles)
                        continue;
                    for (const tile of projectTiles.tiles) {
                        if (!references.find(t => t.id === tile.id)) {
                            references.push(tile);
                        }
                    }
                }
                let weights = {};
                references.sort((a, b) => {
                    if (a.id === b.id)
                        return 0;
                    if (a.bitmap.width !== b.bitmap.width) {
                        return a.bitmap.width - b.bitmap.width;
                    }
                    if (a.isProjectTile !== b.isProjectTile) {
                        if (a.isProjectTile)
                            return -1;
                        else
                            return 1;
                    }
                    return (weights[a.id] || (weights[a.id] = tileWeight(a.id))) -
                        (weights[b.id] || (weights[b.id] = tileWeight(b.id)));
                });
                const getTileImage = (t) => tileWeight(t.id) <= 2 ?
                    mkTransparentTileImage(t.bitmap.width) :
                    pxtblockly.bitmapToImageURI(pxt.sprite.Bitmap.fromData(t.bitmap), PREVIEW_SIDE_LENGTH, false);
                FieldTileset.referencedTiles = references.map(tile => [{
                        src: getTileImage(tile),
                        width: PREVIEW_SIDE_LENGTH,
                        height: PREVIEW_SIDE_LENGTH,
                        alt: displayName(tile)
                    }, tile.id, tile]);
            }
            return FieldTileset.referencedTiles;
        }
        initView() {
            super.initView();
            if (this.sourceBlock_ && this.sourceBlock_.isInFlyout) {
                this.setValue(this.getOptions()[0][1]);
            }
        }
        getValue() {
            if (this.selectedOption_) {
                let tile = this.selectedOption_[2];
                tile = pxt.react.getTilemapProject().lookupAsset(tile.type, tile.id);
                return pxt.getTSReferenceForAsset(tile);
            }
            const v = super.getValue();
            // If the user decompiled from JavaScript, then they might have passed an image literal
            // instead of the qualified name of a tile. The decompiler strips out the "img" part
            // so we need to add it back
            if (typeof v === "string" && v.indexOf(".") === -1 && v.indexOf(`\``) === -1) {
                return `img\`${v}\``;
            }
            return v;
        }
        getText() {
            const v = this.getValue();
            if (typeof v === "string" && v.indexOf("`") !== -1) {
                return v;
            }
            return super.getText();
        }
        render_() {
            if (this.value_ && this.selectedOption_) {
                if (this.selectedOption_[1] !== this.value_) {
                    const tile = pxt.react.getTilemapProject().resolveTile(this.value_);
                    FieldTileset.cachedRevision = -1;
                    if (tile) {
                        this.selectedOption_ = [{
                                src: pxtblockly.bitmapToImageURI(pxt.sprite.Bitmap.fromData(tile.bitmap), PREVIEW_SIDE_LENGTH, false),
                                width: PREVIEW_SIDE_LENGTH,
                                height: PREVIEW_SIDE_LENGTH,
                                alt: displayName(tile)
                            }, this.value_, tile];
                    }
                }
            }
            super.render_();
        }
        doValueUpdate_(newValue) {
            super.doValueUpdate_(newValue);
            const options = this.getOptions(true);
            // This text can be one of four things:
            // 1. The JavaScript expression (assets.tile`name`)
            // 2. The tile id (qualified name)
            // 3. The tile display name
            // 4. Something invalid (like an image literal or undefined)
            if (newValue) {
                // If it's an expression, pull out the id
                const match = pxt.parseAssetTSReference(newValue);
                if (match) {
                    newValue = match.name;
                }
                newValue = newValue.trim();
                for (const option of options) {
                    if (newValue === option[2].id || newValue === option[2].meta.displayName || newValue === pxt.getShortIDForAsset(option[2])) {
                        this.selectedOption_ = option;
                        this.value_ = this.getValue();
                        this.updateAssetListener();
                        return;
                    }
                }
                this.selectedOption_ = null;
                this.updateAssetListener();
            }
        }
        getOptions(opt_useCache) {
            if (typeof this.menuGenerator_ !== 'function') {
                this.transparent = constructTransparentTile();
                return [this.transparent];
            }
            return this.menuGenerator_.call(this);
        }
        dispose() {
            super.dispose();
            pxt.react.getTilemapProject().removeChangeListener("tile" /* Tile */, this.assetChangeListener);
        }
        updateAssetListener() {
            const project = pxt.react.getTilemapProject();
            project.removeChangeListener("tile" /* Tile */, this.assetChangeListener);
            if (this.selectedOption_) {
                project.addChangeListener(this.selectedOption_[2], this.assetChangeListener);
            }
        }
    }
    pxtblockly.FieldTileset = FieldTileset;
    function constructTransparentTile() {
        const tile = pxt.react.getTilemapProject().getTransparency(16);
        return [{
                src: mkTransparentTileImage(16),
                width: PREVIEW_SIDE_LENGTH,
                height: PREVIEW_SIDE_LENGTH,
                alt: pxt.U.lf("transparency")
            }, tile.id, tile];
    }
    function mkTransparentTileImage(sideLength) {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        canvas.width = sideLength;
        canvas.height = sideLength;
        context.fillStyle = "#aeaeae";
        context.fillRect(0, 0, sideLength, sideLength);
        context.fillStyle = "#dedede";
        for (let x = 0; x < sideLength; x += 4) {
            for (let y = 0; y < sideLength; y += 4) {
                if (((x + y) >> 2) & 1)
                    context.fillRect(x, y, 4, 4);
            }
        }
        return canvas.toDataURL();
    }
    function tileWeight(id) {
        switch (id) {
            case "myTiles.transparency16":
                return 1;
            case "myTiles.transparency8":
            case "myTiles.transparency32":
                return 2;
            default:
                if (id.startsWith("myTiles.tile")) {
                    const num = parseInt(id.slice(12));
                    if (!Number.isNaN(num))
                        return num + 2;
                }
                return 9999999999;
        }
    }
    function displayName(tile) {
        return tile.meta.displayName || pxt.getShortIDForAsset(tile);
    }
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/blockly.d.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldToggle extends Blockly.FieldNumber {
        constructor(state, params, opt_validator) {
            super(state, undefined, undefined, undefined, opt_validator);
            this.isFieldCustom_ = true;
            this.CURSOR = 'pointer';
            this.params = params;
            this.setValue(state);
            this.addArgType('toggle');
            this.type_ = params.type;
        }
        initView() {
            if (!this.fieldGroup_) {
                return;
            }
            // Add an attribute to cassify the type of field.
            if (this.getArgTypes() !== null) {
                if (this.sourceBlock_.isShadow()) {
                    this.sourceBlock_.svgGroup_.setAttribute('data-argument-type', this.getArgTypes());
                }
                else {
                    // Fields without a shadow wrapper, like square dropdowns.
                    this.fieldGroup_.setAttribute('data-argument-type', this.getArgTypes());
                }
            }
            // If not in a shadow block, and has more than one input, draw a box.
            if (!this.sourceBlock_.isShadow()
                && (this.sourceBlock_.inputList && this.sourceBlock_.inputList.length > 1)) {
                this.borderRect_ = Blockly.utils.dom.createSvgElement('rect', {
                    'rx': Blockly.BlockSvg.CORNER_RADIUS,
                    'ry': Blockly.BlockSvg.CORNER_RADIUS,
                    'x': 0,
                    'y': 0,
                    'width': this.size_.width,
                    'height': this.size_.height,
                    'fill': this.sourceBlock_.getColour(),
                    'stroke': this.sourceBlock_.getColourTertiary()
                }, null);
                this.fieldGroup_.insertBefore(this.borderRect_, this.textElement_);
            }
            // Adjust X to be flipped for RTL. Position is relative to horizontal start of source block.
            const size = this.getSize();
            this.checkElement_ = Blockly.utils.dom.createSvgElement('g', {
                'class': `blocklyToggle ${this.state_ ? 'blocklyToggleOn' : 'blocklyToggleOff'}`,
                'transform': `translate(8, ${size.height / 2})`,
            }, this.fieldGroup_);
            switch (this.getOutputShape()) {
                case Blockly.OUTPUT_SHAPE_HEXAGONAL:
                    this.toggleThumb_ = Blockly.utils.dom.createSvgElement('polygon', {
                        'class': 'blocklyToggleRect',
                        'points': '-7,-14 -21,0 -7,14 7,14 21,0 7,-14',
                        'cursor': 'pointer'
                    }, this.checkElement_);
                    break;
                case Blockly.OUTPUT_SHAPE_ROUND:
                    this.toggleThumb_ = Blockly.utils.dom.createSvgElement('rect', {
                        'class': 'blocklyToggleCircle',
                        'x': -6, 'y': -14, 'height': 28,
                        'width': 28, 'rx': 14, 'ry': 14,
                        'cursor': 'pointer'
                    }, this.checkElement_);
                    break;
                case Blockly.OUTPUT_SHAPE_SQUARE:
                    this.toggleThumb_ = Blockly.utils.dom.createSvgElement('rect', {
                        'class': 'blocklyToggleRect',
                        'x': -6, 'y': -14, 'height': 28,
                        'width': 28, 'rx': 3, 'ry': 3,
                        'cursor': 'pointer'
                    }, this.checkElement_);
                    break;
            }
            let fieldX = (this.sourceBlock_.RTL) ? -size.width / 2 : size.width / 2;
            /** @type {!Element} */
            this.textElement_ = Blockly.utils.dom.createSvgElement('text', {
                'class': 'blocklyText',
                'x': fieldX,
                'dy': '0.6ex',
                'y': size.height / 2
            }, this.fieldGroup_);
            this.updateEditable();
            const svgRoot = this.sourceBlock_.getSvgRoot();
            svgRoot.appendChild(this.fieldGroup_);
            svgRoot.querySelector(".blocklyBlockBackground").setAttribute('fill', this.sourceBlock_.getColourTertiary());
            this.switchToggle(this.state_);
            this.setValue(this.getValue());
            // Force a render.
            this.markDirty();
        }
        getDisplayText_() {
            return this.state_ ? this.getTrueText() : this.getFalseText();
        }
        getTrueText() {
            return lf("True");
        }
        getFalseText() {
            return lf("False");
        }
        updateSize_() {
            switch (this.getOutputShape()) {
                case Blockly.OUTPUT_SHAPE_ROUND:
                    this.size_.width = this.getInnerWidth() * 2 - 7;
                    break;
                case Blockly.OUTPUT_SHAPE_HEXAGONAL:
                    this.size_.width = this.getInnerWidth() * 2 + 8 - Math.floor(this.getInnerWidth() / 2);
                    break;
                case Blockly.OUTPUT_SHAPE_SQUARE:
                    this.size_.width = 9 + this.getInnerWidth() * 2;
                    break;
            }
        }
        getInnerWidth() {
            return this.getMaxLength() * 10;
        }
        getMaxLength() {
            return Math.max(this.getTrueText().length, this.getFalseText().length);
        }
        getOutputShape() {
            return this.sourceBlock_.isShadow() ? this.sourceBlock_.getOutputShape() : Blockly.OUTPUT_SHAPE_SQUARE;
        }
        doClassValidation_(newBool) {
            return typeof this.fromVal(newBool) == "boolean" ? newBool : "false";
        }
        applyColour() {
            let color = this.sourceBlock_.getColourTertiary();
            if (this.borderRect_) {
                this.borderRect_.setAttribute('stroke', color);
            }
            else {
                this.sourceBlock_.pathObject.svgPath.setAttribute('fill', color);
            }
        }
        ;
        /**
         * Return 'TRUE' if the toggle is ON, 'FALSE' otherwise.
         * @return {string} Current state.
         */
        getValue() {
            return this.toVal(this.state_);
        }
        ;
        /**
         * Set the checkbox to be checked if newBool is 'TRUE' or true,
         * unchecks otherwise.
         * @param {string|boolean} newBool New state.
         */
        doValueUpdate_(newBool) {
            let newState = this.fromVal(newBool);
            if (this.state_ !== newState) {
                if (this.sourceBlock_ && Blockly.Events.isEnabled()) {
                    Blockly.Events.fire(new Blockly.Events.BlockChange(this.sourceBlock_, 'field', this.name, this.state_, newState));
                }
                this.state_ = newState;
                this.switchToggle(this.state_);
                this.isDirty_ = true;
            }
        }
        switchToggle(newState) {
            if (this.checkElement_) {
                this.updateSize_();
                const size = this.getSize();
                const innerWidth = this.getInnerWidth();
                if (newState) {
                    pxt.BrowserUtils.addClass(this.checkElement_, 'blocklyToggleOn');
                    pxt.BrowserUtils.removeClass(this.checkElement_, 'blocklyToggleOff');
                }
                else {
                    pxt.BrowserUtils.removeClass(this.checkElement_, 'blocklyToggleOn');
                    pxt.BrowserUtils.addClass(this.checkElement_, 'blocklyToggleOff');
                }
                const outputShape = this.getOutputShape();
                let width = 0, halfWidth = 0;
                let leftPadding = 0, rightPadding = 0;
                switch (outputShape) {
                    case Blockly.OUTPUT_SHAPE_HEXAGONAL:
                        width = size.width / 2;
                        halfWidth = width / 2;
                        leftPadding = -halfWidth; // total translation when toggle is left-aligned = 0
                        rightPadding = halfWidth - innerWidth; // total translation when right-aligned = width
                        /**
                         *  Toggle defined clockwise from bottom left:
                         *
                         *        0,  14 ----------- width, 14
                         *       /                           \
                         *  -14, 0                            width + 14, 0
                         *       \                           /
                         *        0, -14 ----------- width, -14
                         */
                        this.toggleThumb_.setAttribute('points', `${0},-14 -14,0 ${0},14 ${width},14 ${width + 14},0 ${width},-14`);
                        break;
                    case Blockly.OUTPUT_SHAPE_ROUND:
                    case Blockly.OUTPUT_SHAPE_SQUARE:
                        width = 5 + innerWidth;
                        halfWidth = width / 2;
                        this.toggleThumb_.setAttribute('width', "" + width);
                        this.toggleThumb_.setAttribute('x', `-${halfWidth}`);
                        leftPadding = rightPadding = outputShape == Blockly.OUTPUT_SHAPE_SQUARE ? 2 : -6;
                        break;
                }
                this.checkElement_.setAttribute('transform', `translate(${newState ? rightPadding + innerWidth + halfWidth : halfWidth + leftPadding}, ${size.height / 2})`);
            }
        }
        render_() {
            if (this.visible_ && this.textElement_) {
                // Replace the text.
                goog.dom.removeChildren(/** @type {!Element} */ (this.textElement_));
                let textNode = document.createTextNode(this.getDisplayText_());
                this.textElement_.appendChild(textNode);
                pxt.BrowserUtils.addClass(this.textElement_, 'blocklyToggleText');
                this.updateSize_();
                // Update text centering, based on newly calculated width.
                let width = this.size_.width;
                let centerTextX = this.state_ ? (width + width / 8) : width / 2;
                // Apply new text element x position.
                let newX = centerTextX - width / 2;
                this.textElement_.setAttribute('x', `${newX}`);
            }
            // Update any drawn box to the correct width and height.
            if (this.borderRect_) {
                this.borderRect_.setAttribute('width', `${this.size_.width}`);
                this.borderRect_.setAttribute('height', `${this.size_.height}`);
            }
        }
        /**
         * Toggle the state of the toggle.
         * @private
         */
        showEditor_() {
            let newState = !this.state_;
            /*
            if (this.sourceBlock_) {
              // Call any validation function, and allow it to override.
              newState = this.callValidator(newState);
            }*/
            if (newState !== null) {
                this.setValue(this.toVal(newState));
            }
        }
        toVal(newState) {
            if (this.type_ == "number")
                return String(newState ? '1' : '0');
            else
                return String(newState ? 'true' : 'false');
        }
        fromVal(val) {
            if (typeof val == "string") {
                if (val == "1" || val.toUpperCase() == "TRUE")
                    return true;
                return false;
            }
            return !!val;
        }
    }
    pxtblockly.FieldToggle = FieldToggle;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/blockly.d.ts" />
/// <reference path="./field_toggle.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldToggleHighLow extends pxtblockly.FieldToggle {
        constructor(state, params, opt_validator) {
            super(state, params, opt_validator);
            this.isFieldCustom_ = true;
        }
        getTrueText() {
            return lf("HIGH");
        }
        getFalseText() {
            return lf("LOW");
        }
    }
    pxtblockly.FieldToggleHighLow = FieldToggleHighLow;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/blockly.d.ts" />
/// <reference path="./field_toggle.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldToggleOnOff extends pxtblockly.FieldToggle {
        constructor(state, params, opt_validator) {
            super(state, params, opt_validator);
            this.isFieldCustom_ = true;
        }
        getTrueText() {
            return lf("ON");
        }
        getFalseText() {
            return lf("OFF");
        }
    }
    pxtblockly.FieldToggleOnOff = FieldToggleOnOff;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/blockly.d.ts" />
/// <reference path="./field_toggle.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldToggleUpDown extends pxtblockly.FieldToggle {
        constructor(state, params, opt_validator) {
            super(state, params, opt_validator);
            this.isFieldCustom_ = true;
        }
        getTrueText() {
            return lf("UP");
        }
        getFalseText() {
            return lf("DOWN");
        }
    }
    pxtblockly.FieldToggleUpDown = FieldToggleUpDown;
    class FieldToggleDownUp extends pxtblockly.FieldToggle {
        constructor(state, params, opt_validator) {
            super(state, params, opt_validator);
            this.isFieldCustom_ = true;
        }
        getTrueText() {
            return lf("DOWN");
        }
        getFalseText() {
            return lf("UP");
        }
    }
    pxtblockly.FieldToggleDownUp = FieldToggleDownUp;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/blockly.d.ts" />
/// <reference path="./field_toggle.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldToggleWinLose extends pxtblockly.FieldToggle {
        constructor(state, params, opt_validator) {
            super(state, params, opt_validator);
            this.isFieldCustom_ = true;
        }
        getTrueText() {
            return lf("WIN");
        }
        getFalseText() {
            return lf("LOSE");
        }
    }
    pxtblockly.FieldToggleWinLose = FieldToggleWinLose;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/blockly.d.ts" />
/// <reference path="./field_toggle.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldToggleYesNo extends pxtblockly.FieldToggle {
        constructor(state, params, opt_validator) {
            super(state, params, opt_validator);
            this.isFieldCustom_ = true;
        }
        getTrueText() {
            return lf("Yes");
        }
        getFalseText() {
            return lf("No");
        }
    }
    pxtblockly.FieldToggleYesNo = FieldToggleYesNo;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/blockly.d.ts" />
var pxtblockly;
(function (pxtblockly) {
    class FieldTsExpression extends Blockly.FieldTextInput {
        constructor() {
            super(...arguments);
            this.isFieldCustom_ = true;
            this.pythonMode = false;
        }
        /**
         * Same as parent, but adds a different class to text when disabled
         */
        updateEditable() {
            let group = this.fieldGroup_;
            if (!this.EDITABLE || !group) {
                return;
            }
            if (this.sourceBlock_.isEditable()) {
                pxt.BrowserUtils.addClass(group, 'blocklyEditableText');
                pxt.BrowserUtils.removeClass(group, 'blocklyGreyExpressionBlockText');
                this.fieldGroup_.style.cursor = this.CURSOR;
            }
            else {
                pxt.BrowserUtils.addClass(group, 'blocklyGreyExpressionBlockText');
                pxt.BrowserUtils.removeClass(group, 'blocklyEditableText');
                this.fieldGroup_.style.cursor = '';
            }
        }
        setPythonEnabled(enabled) {
            if (enabled === this.pythonMode)
                return;
            this.pythonMode = enabled;
            this.forceRerender();
        }
        getText() {
            return this.pythonMode ? pxt.Util.lf("<python code>") : this.getValue();
        }
        applyColour() {
            var _a;
            if (this.sourceBlock_ && ((_a = this.getConstants()) === null || _a === void 0 ? void 0 : _a.FULL_BLOCK_FIELDS)) {
                if (this.borderRect_) {
                    this.borderRect_.setAttribute('stroke', this.sourceBlock_.style.colourTertiary);
                }
            }
        }
    }
    pxtblockly.FieldTsExpression = FieldTsExpression;
})(pxtblockly || (pxtblockly = {}));
/// <reference path="../../localtypings/blockly.d.ts"/>
/// <reference path="../../built/pxtsim.d.ts"/>
var pxtblockly;
(function (pxtblockly) {
    class FieldTurnRatio extends Blockly.FieldSlider {
        /**
         * Class for a color wheel field.
         * @param {number|string} value The initial content of the field.
         * @param {Function=} opt_validator An optional function that is called
         *     to validate any constraints on what the user entered.  Takes the new
         *     text as an argument and returns either the accepted text, a replacement
         *     text, or null to abort the change.
         * @extends {Blockly.FieldNumber}
         * @constructor
         */
        constructor(value_, params, opt_validator) {
            super(String(value_), '-200', '200', '1', '10', 'TurnRatio', opt_validator);
            this.isFieldCustom_ = true;
            this.params = params;
            this.sliderColor_ = '#a8aaa8';
        }
        createLabelDom_(labelText) {
            let labelContainer = document.createElement('div');
            let svg = Blockly.utils.dom.createSvgElement('svg', {
                'xmlns': 'http://www.w3.org/2000/svg',
                'xmlns:html': 'http://www.w3.org/1999/xhtml',
                'xmlns:xlink': 'http://www.w3.org/1999/xlink',
                'version': '1.1',
                'height': (FieldTurnRatio.HALF + FieldTurnRatio.HANDLE_RADIUS + 10) + 'px',
                'width': (FieldTurnRatio.HALF * 2) + 'px'
            }, labelContainer);
            let defs = Blockly.utils.dom.createSvgElement('defs', {}, svg);
            let marker = Blockly.utils.dom.createSvgElement('marker', {
                'id': 'head',
                'orient': "auto",
                'markerWidth': '2',
                'markerHeight': '4',
                'refX': '0.1', 'refY': '1.5'
            }, defs);
            let markerPath = Blockly.utils.dom.createSvgElement('path', {
                'd': 'M0,0 V3 L1.5,1.5 Z',
                'fill': '#f12a21'
            }, marker);
            this.reporter_ = pxsim.svg.child(svg, "text", {
                'x': FieldTurnRatio.HALF, 'y': 96,
                'text-anchor': 'middle', 'dominant-baseline': 'middle',
                'style': 'font-size: 50px',
                'class': 'sim-text inverted number'
            });
            this.path_ = Blockly.utils.dom.createSvgElement('path', {
                'x1': FieldTurnRatio.HALF,
                'y1': FieldTurnRatio.HALF,
                'marker-end': 'url(#head)',
                'style': 'fill: none; stroke: #f12a21; stroke-width: 10'
            }, svg);
            this.updateGraph_();
            let readout = document.createElement('span');
            readout.setAttribute('class', 'blocklyFieldSliderReadout');
            return [labelContainer, readout];
        }
        ;
        updateGraph_() {
            if (!this.path_) {
                return;
            }
            let v = goog.math.clamp(this.getValue() || 0, -200, 200);
            const x = v / 100;
            const nx = Math.max(-1, Math.min(1, x));
            const theta = Math.max(nx) * Math.PI / 2;
            const r = FieldTurnRatio.RADIUS - 6;
            let cx = FieldTurnRatio.HALF;
            const cy = FieldTurnRatio.HALF - 22;
            if (Math.abs(x) > 1) {
                cx -= (x - (x > 0 ? 1 : -1)) * r / 2; // move center of circle
            }
            const alpha = 0.2 + Math.abs(nx) * 0.5;
            const y1 = r * alpha;
            const y2 = r * Math.sin(Math.PI / 2 - theta);
            const x2 = r * Math.cos(Math.PI / 2 - theta);
            const y3 = y2 - r * alpha * Math.cos(2 * theta);
            const x3 = x2 - r * alpha * Math.sin(2 * theta);
            const d = `M ${cx} ${cy} C ${cx} ${cy - y1} ${cx + x3} ${cy - y3} ${cx + x2} ${cy - y2}`;
            this.path_.setAttribute('d', d);
            this.reporter_.textContent = `${v}`;
        }
        setReadout_(readout, value) {
            this.updateGraph_();
        }
    }
    FieldTurnRatio.HALF = 80;
    FieldTurnRatio.HANDLE_RADIUS = 30;
    FieldTurnRatio.RADIUS = FieldTurnRatio.HALF - FieldTurnRatio.HANDLE_RADIUS - 1;
    pxtblockly.FieldTurnRatio = FieldTurnRatio;
})(pxtblockly || (pxtblockly = {}));
var pxtblockly;
(function (pxtblockly) {
    class FieldUserEnum extends Blockly.FieldDropdown {
        constructor(opts) {
            super(createMenuGenerator(opts));
            this.opts = opts;
        }
        init() {
            super.init();
            this.initVariables();
        }
        onItemSelected_(menu, menuItem) {
            const value = menuItem.getValue();
            if (value === "CREATE") {
                promptAndCreateEnum(this.sourceBlock_.workspace, this.opts, lf("New {0}:", this.opts.memberName), newName => newName && this.setValue(newName));
            }
            else {
                super.onItemSelected_(menu, menuItem);
            }
        }
        doClassValidation_(value) {
            var _a;
            // update cached option list when adding a new kind
            if (((_a = this.opts) === null || _a === void 0 ? void 0 : _a.initialMembers) && !this.opts.initialMembers.find(el => el == value))
                this.getOptions();
            return super.doClassValidation_(value);
        }
        initVariables() {
            if (this.sourceBlock_ && this.sourceBlock_.workspace) {
                const ws = this.sourceBlock_.workspace;
                const existing = getMembersForEnum(ws, this.opts.name);
                this.opts.initialMembers.forEach(memberName => {
                    if (!existing.some(([name, value]) => name === memberName)) {
                        createNewEnumMember(ws, this.opts, memberName);
                    }
                });
                if (this.getValue() === "CREATE") {
                    const newValue = getVariableNameForMember(ws, this.opts.name, this.opts.initialMembers[0]);
                    if (newValue) {
                        this.setValue(newValue);
                    }
                }
            }
        }
    }
    pxtblockly.FieldUserEnum = FieldUserEnum;
    function createMenuGenerator(opts) {
        return function () {
            const res = [];
            const that = this;
            if (that.sourceBlock_ && that.sourceBlock_.workspace) {
                const options = that.sourceBlock_.workspace.getVariablesOfType(opts.name);
                options.forEach(model => {
                    // The format of the name is 10mem where "10" is the value and "mem" is the enum member
                    const withoutValue = model.name.replace(/^\d+/, "");
                    res.push([withoutValue, model.name]);
                });
            }
            else {
                // Can't create variables from within the flyout, so we just have to fake it
                opts.initialMembers.forEach((e) => res.push([e, e]));
            }
            res.push([lf("Add a new {0}...", opts.memberName), "CREATE"]);
            return res;
        };
    }
    function promptAndCreateEnum(ws, opts, message, cb) {
        Blockly.prompt(message, null, response => {
            if (response) {
                let nameIsValid = false;
                if (pxtc.isIdentifierStart(response.charCodeAt(0), 2)) {
                    nameIsValid = true;
                    for (let i = 1; i < response.length; i++) {
                        if (!pxtc.isIdentifierPart(response.charCodeAt(i), 2)) {
                            nameIsValid = false;
                        }
                    }
                }
                if (!nameIsValid) {
                    Blockly.alert(lf("Names must start with a letter and can only contain letters, numbers, '$', and '_'."), () => promptAndCreateEnum(ws, opts, message, cb));
                    return;
                }
                const existing = getMembersForEnum(ws, opts.name);
                for (let i = 0; i < existing.length; i++) {
                    const [name, value] = existing[i];
                    if (name === response) {
                        Blockly.alert(lf("A {0} named '{1}' already exists.", opts.memberName, response), () => promptAndCreateEnum(ws, opts, message, cb));
                        return;
                    }
                }
                cb(createNewEnumMember(ws, opts, response));
            }
        }, { placeholder: opts.promptHint });
    }
    function parseName(model) {
        const match = /^(\d+)([^0-9].*)$/.exec(model.name);
        if (match) {
            return [match[2], parseInt(match[1])];
        }
        return [model.name, -1];
    }
    function getMembersForEnum(ws, enumName) {
        const existing = ws.getVariablesOfType(enumName);
        if (existing && existing.length) {
            return existing.map(parseName);
        }
        else {
            return [];
        }
    }
    function getNextValue(members, opts) {
        const existing = members.map(([name, value]) => value);
        if (opts.isBitMask) {
            for (let i = 0; i < existing.length; i++) {
                let current = 1 << i;
                if (existing.indexOf(current) < 0) {
                    return current;
                }
            }
            return 1 << existing.length;
        }
        else if (opts.isHash) {
            return 0; // overriden when compiled
        }
        else {
            const start = opts.firstValue || 0;
            for (let i = 0; i < existing.length; i++) {
                if (existing.indexOf(start + i) < 0) {
                    return start + i;
                }
            }
            return start + existing.length;
        }
    }
    pxtblockly.getNextValue = getNextValue;
    function createNewEnumMember(ws, opts, newName) {
        const ex = getMembersForEnum(ws, opts.name);
        const val = getNextValue(ex, opts);
        const variableName = val + newName;
        Blockly.Variables.getOrCreateVariablePackage(ws, null, variableName, opts.name);
        return variableName;
    }
    function getVariableNameForMember(ws, enumName, memberName) {
        const existing = ws.getVariablesOfType(enumName);
        if (existing && existing.length) {
            for (let i = 0; i < existing.length; i++) {
                const [name,] = parseName(existing[i]);
                if (name === memberName) {
                    return existing[i].name;
                }
            }
        }
        return undefined;
    }
})(pxtblockly || (pxtblockly = {}));
var pxtblockly;
(function (pxtblockly) {
    let svg;
    (function (svg) {
        function hasClass(el, cls) {
            return pxt.BrowserUtils.containsClass(el, cls);
        }
        svg.hasClass = hasClass;
        function addClass(el, cls) {
            pxt.BrowserUtils.addClass(el, cls);
        }
        svg.addClass = addClass;
        function removeClass(el, cls) {
            pxt.BrowserUtils.removeClass(el, cls);
        }
        svg.removeClass = removeClass;
    })(svg = pxtblockly.svg || (pxtblockly.svg = {}));
    function parseColour(colour) {
        const hue = Number(colour);
        if (!isNaN(hue)) {
            return Blockly.hueToRgb(hue);
        }
        else if (goog.isString(colour) && colour.match(/^#[0-9a-fA-F]{6}$/)) {
            return colour;
        }
        else {
            return '#000';
        }
    }
    pxtblockly.parseColour = parseColour;
    /**
     * Converts a bitmap into a square image suitable for display. In light mode the preview
     * is drawn with no transparency (alpha is filled with background color)
     */
    function bitmapToImageURI(frame, sideLength, lightMode) {
        const colors = pxt.appTarget.runtime.palette.slice(1);
        const canvas = document.createElement("canvas");
        canvas.width = sideLength;
        canvas.height = sideLength;
        // Works well for all of our default sizes, does not work well if the size is not
        // a multiple of 2 or is greater than 32 (i.e. from the decompiler)
        const cellSize = Math.min(sideLength / frame.width, sideLength / frame.height);
        // Center the image if it isn't square
        const xOffset = Math.max(Math.floor((sideLength * (1 - (frame.width / frame.height))) / 2), 0);
        const yOffset = Math.max(Math.floor((sideLength * (1 - (frame.height / frame.width))) / 2), 0);
        let context;
        if (lightMode) {
            context = canvas.getContext("2d", { alpha: false });
            context.fillStyle = "#dedede";
            context.fillRect(0, 0, sideLength, sideLength);
        }
        else {
            context = canvas.getContext("2d");
        }
        for (let c = 0; c < frame.width; c++) {
            for (let r = 0; r < frame.height; r++) {
                const color = frame.get(c, r);
                if (color) {
                    context.fillStyle = colors[color - 1];
                    context.fillRect(xOffset + c * cellSize, yOffset + r * cellSize, cellSize, cellSize);
                }
                else if (lightMode) {
                    context.fillStyle = "#dedede";
                    context.fillRect(xOffset + c * cellSize, yOffset + r * cellSize, cellSize, cellSize);
                }
            }
        }
        return canvas.toDataURL();
    }
    pxtblockly.bitmapToImageURI = bitmapToImageURI;
    function tilemapToImageURI(data, sideLength, lightMode) {
        const colors = pxt.appTarget.runtime.palette.slice();
        const canvas = document.createElement("canvas");
        canvas.width = sideLength;
        canvas.height = sideLength;
        // Works well for all of our default sizes, does not work well if the size is not
        // a multiple of 2 or is greater than 32 (i.e. from the decompiler)
        const cellSize = Math.min(sideLength / data.tilemap.width, sideLength / data.tilemap.height);
        // Center the image if it isn't square
        const xOffset = Math.max(Math.floor((sideLength * (1 - (data.tilemap.width / data.tilemap.height))) / 2), 0);
        const yOffset = Math.max(Math.floor((sideLength * (1 - (data.tilemap.height / data.tilemap.width))) / 2), 0);
        let context;
        if (lightMode) {
            context = canvas.getContext("2d", { alpha: false });
            context.fillStyle = "#dedede";
            context.fillRect(0, 0, sideLength, sideLength);
        }
        else {
            context = canvas.getContext("2d");
        }
        let tileColors = [];
        for (let c = 0; c < data.tilemap.width; c++) {
            for (let r = 0; r < data.tilemap.height; r++) {
                const tile = data.tilemap.get(c, r);
                if (tile) {
                    if (!tileColors[tile]) {
                        const tileInfo = data.tileset.tiles[tile];
                        tileColors[tile] = tileInfo ? pxt.sprite.computeAverageColor(pxt.sprite.Bitmap.fromData(tileInfo.bitmap), colors) : "#dedede";
                    }
                    context.fillStyle = tileColors[tile];
                    context.fillRect(xOffset + c * cellSize, yOffset + r * cellSize, cellSize, cellSize);
                }
                else if (lightMode) {
                    context.fillStyle = "#dedede";
                    context.fillRect(xOffset + c * cellSize, yOffset + r * cellSize, cellSize, cellSize);
                }
            }
        }
        return canvas.toDataURL();
    }
    pxtblockly.tilemapToImageURI = tilemapToImageURI;
    function deleteTilesetTileIfExists(ws, tile) {
        const existing = ws.getVariablesOfType(pxt.sprite.BLOCKLY_TILESET_TYPE);
        for (const model of existing) {
            if (parseInt(model.name.substr(0, model.name.indexOf(";"))) === tile.projectId) {
                ws.deleteVariableById(model.getId());
                break;
            }
        }
    }
    function getAllBlocksWithTilemaps(ws) {
        return getAllFields(ws, f => f instanceof pxtblockly.FieldTilemap && !f.isGreyBlock);
    }
    pxtblockly.getAllBlocksWithTilemaps = getAllBlocksWithTilemaps;
    function getAllBlocksWithTilesets(ws) {
        return getAllFields(ws, f => f instanceof pxtblockly.FieldTileset);
    }
    pxtblockly.getAllBlocksWithTilesets = getAllBlocksWithTilesets;
    function needsTilemapUpgrade(ws) {
        const allTiles = ws.getVariablesOfType(pxt.sprite.BLOCKLY_TILESET_TYPE).map(model => pxt.sprite.legacy.blocklyVariableToTile(model.name));
        return !!allTiles.length;
    }
    pxtblockly.needsTilemapUpgrade = needsTilemapUpgrade;
    function upgradeTilemapsInWorkspace(ws, proj) {
        const allTiles = ws.getVariablesOfType(pxt.sprite.BLOCKLY_TILESET_TYPE).map(model => pxt.sprite.legacy.blocklyVariableToTile(model.name));
        if (!allTiles.length)
            return;
        try {
            Blockly.Events.disable();
            let customMapping = [];
            for (const tile of allTiles) {
                if (tile.qualifiedName) {
                    customMapping[tile.projectId] = proj.resolveTile(tile.qualifiedName);
                }
                else if (tile.data) {
                    customMapping[tile.projectId] = proj.createNewTile(tile.data, "myTiles.tile" + tile.projectId);
                }
                deleteTilesetTileIfExists(ws, tile);
            }
            const tilemaps = getAllBlocksWithTilemaps(ws);
            for (const tilemap of tilemaps) {
                const legacy = pxt.sprite.legacy.decodeTilemap(tilemap.ref.getInitText(), "typescript");
                const mapping = [];
                const newData = new pxt.sprite.TilemapData(legacy.tilemap, {
                    tileWidth: legacy.tileset.tileWidth,
                    tiles: legacy.tileset.tiles.map((t, index) => {
                        if (t.projectId != null) {
                            return customMapping[t.projectId];
                        }
                        if (!mapping[index]) {
                            mapping[index] = proj.resolveTile(t.qualifiedName);
                        }
                        return mapping[index];
                    })
                }, legacy.layers);
                tilemap.ref.setValue(pxt.sprite.encodeTilemap(newData, "typescript"));
            }
            const tilesets = getAllBlocksWithTilesets(ws);
            for (const tileset of tilesets) {
                // Force a re-render
                tileset.ref.doValueUpdate_(tileset.ref.getValue());
                if (tileset.ref.isDirty_) {
                    tileset.ref.forceRerender();
                }
            }
        }
        finally {
            Blockly.Events.enable();
        }
    }
    pxtblockly.upgradeTilemapsInWorkspace = upgradeTilemapsInWorkspace;
    function getAllFields(ws, predicate) {
        const result = [];
        const top = ws.getTopBlocks(false);
        top.forEach(block => getAllFieldsRecursive(block));
        return result;
        function getAllFieldsRecursive(block) {
            for (const input of block.inputList) {
                for (const field of input.fieldRow) {
                    if (predicate(field)) {
                        result.push({ block, field: field.name, ref: field });
                    }
                }
                if (input.connection && input.connection.targetBlock()) {
                    getAllFieldsRecursive(input.connection.targetBlock());
                }
            }
            if (block.nextConnection && block.nextConnection.targetBlock()) {
                getAllFieldsRecursive(block.nextConnection.targetBlock());
            }
        }
    }
    pxtblockly.getAllFields = getAllFields;
    function getAllReferencedTiles(workspace, excludeBlockID) {
        var _a;
        let all = {};
        const allMaps = getAllBlocksWithTilemaps(workspace);
        const project = pxt.react.getTilemapProject();
        for (const map of allMaps) {
            if (map.block.id === excludeBlockID)
                continue;
            for (const tile of ((_a = map.ref.getTileset()) === null || _a === void 0 ? void 0 : _a.tiles) || []) {
                all[tile.id] = project.lookupAsset("tile" /* Tile */, tile.id);
            }
        }
        const projectMaps = project.getAssets("tilemap" /* Tilemap */);
        for (const projectMap of projectMaps) {
            for (const tile of projectMap.data.tileset.tiles) {
                all[tile.id] = project.lookupAsset("tile" /* Tile */, tile.id);
            }
        }
        const allTiles = getAllBlocksWithTilesets(workspace);
        for (const tilesetField of allTiles) {
            const value = tilesetField.ref.getValue();
            const match = /^\s*assets\s*\.\s*tile\s*`([^`]*)`\s*$/.exec(value);
            if (match) {
                const tile = project.lookupAssetByName("tile" /* Tile */, match[1]);
                if (tile && !all[tile.id]) {
                    all[tile.id] = tile;
                }
            }
            else if (!all[value]) {
                all[value] = project.resolveTile(value);
            }
        }
        return Object.keys(all).map(key => all[key]).filter(t => !!t);
    }
    pxtblockly.getAllReferencedTiles = getAllReferencedTiles;
    function getTemporaryAssets(workspace, type) {
        switch (type) {
            case "image" /* Image */:
                return getAllFields(workspace, field => field instanceof pxtblockly.FieldSpriteEditor && field.isTemporaryAsset())
                    .map(f => f.ref.getAsset());
            case "animation" /* Animation */:
                return getAllFields(workspace, field => field instanceof pxtblockly.FieldAnimationEditor && field.isTemporaryAsset())
                    .map(f => f.ref.getAsset());
            default: return [];
        }
    }
    pxtblockly.getTemporaryAssets = getTemporaryAssets;
    function workspaceToScreenCoordinates(ws, wsCoordinates) {
        // The position in pixels relative to the origin of the
        // main workspace.
        const scaledWS = wsCoordinates.scale(ws.scale);
        // The offset in pixels between the main workspace's origin and the upper
        // left corner of the injection div.
        const mainOffsetPixels = ws.getOriginOffsetInPixels();
        // The client coordinates offset by the injection div's upper left corner.
        const clientOffsetPixels = Blockly.utils.Coordinate.sum(scaledWS, mainOffsetPixels);
        const injectionDiv = ws.getInjectionDiv();
        // Bounding rect coordinates are in client coordinates, meaning that they
        // are in pixels relative to the upper left corner of the visible browser
        // window.  These coordinates change when you scroll the browser window.
        const boundingRect = injectionDiv.getBoundingClientRect();
        return new Blockly.utils.Coordinate(clientOffsetPixels.x + boundingRect.left, clientOffsetPixels.y + boundingRect.top);
    }
    pxtblockly.workspaceToScreenCoordinates = workspaceToScreenCoordinates;
})(pxtblockly || (pxtblockly = {}));
