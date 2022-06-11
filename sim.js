/// <reference path="../libs/core/enums.d.ts"/>
var pxsim;
(function (pxsim) {
    var turtle;
    (function (turtle) {
        /**
         * Move the turtle forward
         * @param distance distance to move, eg: 50
         */
        //% weight=90
        //% blockId=turtleForward block="forward %distance steps"
        async function forwardAsync(distance) {
            await pxsim.board().move(distance);
        }
        turtle.forwardAsync = forwardAsync;
        /**
         * Move the turtle backward
         * @param distance distance to move, eg: 50
         */
        //% weight=85
        //% blockId=turtleBackward block="backward %distance steps"
        async function backwardAsync(distance) {
            await pxsim.board().move(-distance);
        }
        turtle.backwardAsync = backwardAsync;
        /**
         * Turn the turtle to the right
         * @param angle degrees to turn, eg: 90
         */
        //% weight=80
        //% blockId=turtleTurnRight block="turn right by %angle degrees"
        //% angle.min=0 angle.max=360
        async function turnRightAsync(angle) {
            await pxsim.board().turn(angle);
        }
        turtle.turnRightAsync = turnRightAsync;
        /**
         * Turn the turtle to the left
         * @param angle degrees to turn, eg: 90
         */
        //% weight=75
        //% blockId=turtleTurnLeft block="turn left by %angle degrees"
        //% angle.min=0 angle.max=360
        async function turnLeftAsync(angle) {
            await pxsim.board().turn(-angle);
        }
        turtle.turnLeftAsync = turnLeftAsync;
        /**
         * Pull the pen up
         */
        //% weight=70
        //% blockId=turtlePenUp block="pull the pen up"
        function penUp() {
            pxsim.board().pen = false;
        }
        turtle.penUp = penUp;
        /**
         * Pull the pen down
         */
        //% weight=65
        //% blockId=turtlePenDown block="pull the pen down"
        function penDown() {
            pxsim.board().pen = true;
        }
        turtle.penDown = penDown;
        /**
         * Move the turtle to the origin and set heading to 0
         */
        //% weight=60
        //% blockId=turtleHome block="back to home"
        async function homeAsync() {
            await pxsim.board().moveTo(0, 0, 0);
        }
        turtle.homeAsync = homeAsync;
        /**
         * X position of the turtle
         */
        //% weight=55
        //% blockId=turtleX block="x position"
        function x() {
            return pxsim.board().x;
        }
        turtle.x = x;
        /**
         * Y position of the turtle
         */
        //% weight=54
        //% blockId=turtleY block="y position"
        function y() {
            return pxsim.board().y;
        }
        turtle.y = y;
        /**
         * Heading of the turtle
         */
        //% weight=53
        //% blockId=turtleHeading block="heading"
        function heading() {
            return pxsim.board().heading;
        }
        turtle.heading = heading;
        /**
         * Set the speed of the turtle
         * @param speed turtle speed, eg: Speed.Fast
         */
        //% weight=40
        //% blockId=turtleSpeed block="set speed to %speed"
        function setSpeed(speed) {
            pxsim.board().speed = speed;
        }
        turtle.setSpeed = setSpeed;
        /**
         * Set the pen color
         * @param color pen color, eg: 0x007fff
         */
        //% weight=50
        //% blockId="turtlePenColor" block="set pen color to %color=colorNumberPicker"
        function setPenColor(color) {
            pxsim.board().penColor = color;
        }
        turtle.setPenColor = setPenColor;
        /**
         * Set the pen size
         * @param size pen size, eg: 3
         */
        //% weight=45
        //% blockId="turtlePenSize" block="set pen size to %size"
        //% size.min=1 size.max=10
        function setPenSize(size) {
            pxsim.board().penSize = size;
        }
        turtle.setPenSize = setPenSize;
        /**
         * Show the turtle
         */
        //% weight=30
        //% blockId=turtleShow block="show turtle"
        function show() {
            pxsim.board().turtle = true;
        }
        turtle.show = show;
        /**
         * Hide the turtle
         */
        //% weight=35
        //% blockId=turtleHide block="hide turtle"
        function hide() {
            pxsim.board().turtle = false;
        }
        turtle.hide = hide;
        /**
         * Move the turtle to the given position
         * @param xpos x position
         * @param ypos y position
         */
        //% weight=29
        //% blockId=turtleGoto block="goto x=%xpos and y=%ypos"
        async function gotoAsync(xpos, ypos) {
            await pxsim.board().moveTo(xpos, ypos, pxsim.board().heading);
        }
        turtle.gotoAsync = gotoAsync;
        /**
         * Print a text and move forward
         * @param text text to print, eg: "Hello World"
         */
        //% weight=20
        //% blockId=turtlePrintAndMove block="print %text and move forward"
        async function printAndMoveAsync(text) {
            await pxsim.board().print(text, true);
        }
        turtle.printAndMoveAsync = printAndMoveAsync;
        /**
         * Print a text and stand still
         * @param text text to print, eg: "Hello World"
         */
        //% weight=25
        //% blockId=turtlePrint block="print %text"
        async function printAsync(text) {
            await pxsim.board().print(text, false);
        }
        turtle.printAsync = printAsync;
        /**
         * Clear the canvas
         */
        //% weight=15
        //% blockId=turtleClear block="clear the canvas"
        function clear() {
            pxsim.board().clear();
        }
        turtle.clear = clear;
    })(turtle = pxsim.turtle || (pxsim.turtle = {}));
})(pxsim || (pxsim = {}));
/// <reference path="../node_modules/pxt-core/built/pxtsim.d.ts"/>
async function delay(duration, value) {
    // eslint-disable-next-line
    const output = await value;
    await new Promise(resolve => setTimeout(() => resolve(), duration));
    return output;
}
var pxsim;
(function (pxsim) {
    pxsim.initCurrentRuntime = () => {
        pxsim.runtime.board = new TurtleBoard();
    };
    function board() {
        return pxsim.runtime.board;
    }
    pxsim.board = board;
    class TurtleBoard extends pxsim.BaseBoard {
        constructor() {
            super();
            this.x = 0;
            this.y = 0;
            this.heading = 0;
            this.pen = true;
            this.penSize = 2;
            this.delay = delays[1 /* Speed.Normal */];
            this.color = "#ff0000";
            this.stage = new createjs.Stage("canvas");
            createjs.Ticker.addEventListener("tick", this.stage);
            const canvas = this.stage.canvas;
            canvas.getContext("2d").imageSmoothingEnabled = false;
            this.xOffset = canvas.width / 2;
            this.yOffset = canvas.height / 2;
            const rect = this.stage.addChild(new createjs.Shape());
            rect.graphics.beginFill("white").rect(0, 0, canvas.width, canvas.height);
        }
        async initAsync(msg) {
            const sprite = await pxsim.createTurtleSprite();
            sprite.x = this.xOffset;
            sprite.y = this.yOffset;
            sprite.paused = true;
            this.turtleSprite = this.stage.addChild(sprite);
            // avoid flickering on start
            await delay(1000);
        }
        kill() {
            createjs.Ticker.removeEventListener("tick", this.stage);
        }
        set speed(s) {
            this.delay = delays[s];
        }
        set penColor(color) {
            this.color = `#${("00000" + color.toString(16)).substring(-6)}`;
        }
        set turtle(visible) {
            this.turtleSprite.visible = visible;
        }
        move(distance) {
            const x = this.x;
            const y = this.y;
            this.x += distance * Math.sin(this.heading * Math.PI / 180);
            this.y += distance * Math.cos(this.heading * Math.PI / 180);
            const tx = this.xOffset + this.x;
            const ty = this.yOffset - this.y;
            if (this.pen || this.turtleSprite.visible) {
                const line = this.stage.addChild(new createjs.Shape());
                line.visible = this.pen;
                const g = line.graphics
                    .setStrokeStyle(this.penSize)
                    .beginStroke(this.color)
                    .moveTo(this.xOffset + x, this.yOffset - y);
                this.turtleToFront();
                if (this.delay > 0) {
                    const cmd = g.lineTo(this.xOffset + x, this.yOffset - y).command;
                    const duration = this.delay * Math.abs(distance);
                    this.turtleSprite.play();
                    createjs.Tween.get(this.turtleSprite).to({ x: tx, y: ty }, duration);
                    return new Promise((resolve) => {
                        createjs.Tween.get(cmd)
                            .to({ x: tx, y: ty }, duration)
                            .call(() => {
                            this.turtleSprite.gotoAndStop(0);
                            resolve();
                        });
                    });
                }
                g.lineTo(tx, ty).endStroke();
            }
            this.turtleSprite.x = tx;
            this.turtleSprite.y = ty;
            return Promise.resolve();
        }
        turn(angle) {
            const h = (this.heading + angle) % 360;
            const heading = this.heading;
            this.heading = h < 0 ? h + 360 : h;
            if (this.turtleSprite.visible && this.delay > 0) {
                this.turtleSprite.play();
                return new Promise((resolve) => {
                    createjs.Tween.get(this.turtleSprite)
                        .to({ rotation: heading + angle }, this.delay * 0.5 * Math.abs(angle))
                        .call(() => {
                        this.turtleSprite.gotoAndStop(0);
                        this.turtleSprite.rotation = this.heading;
                        resolve();
                    });
                });
            }
            this.turtleSprite.rotation = this.heading;
            return Promise.resolve();
        }
        async moveTo(nx, ny, nh) {
            if (this.x !== nx || this.y !== ny) {
                const pen = this.pen;
                this.pen = false;
                const angle = Math.atan2(this.x - nx, this.y - ny) * 180 / Math.PI;
                await this.turn(normalize(angle - this.heading - 180));
                await this.move(Math.sqrt((this.x - nx) ** 2 + (this.y - ny) ** 2));
                this.pen = pen;
            }
            await this.turn(normalize(nh - this.heading));
            this.x = nx;
            this.y = ny;
            this.heading = nh;
            this.turtleSprite.x = this.xOffset + nx;
            this.turtleSprite.y = this.yOffset - ny;
            this.turtleSprite.rotation = nh;
        }
        async print(text, move) {
            const t = this.stage.addChild(new createjs.Text(text, `${8 + this.penSize * 2}px monospace`, this.color));
            t.x = this.xOffset + this.x;
            t.y = this.yOffset - this.y;
            t.rotation = this.heading - 90;
            t.textBaseline = "middle";
            this.turtleToFront();
            if (move) {
                const pen = this.pen;
                this.pen = false;
                await this.move(t.getBounds().width);
                this.pen = pen;
            }
        }
        clear() {
            while (this.stage.numChildren > 2) {
                this.stage.removeChildAt(1);
            }
        }
        turtleToFront() {
            this.stage.setChildIndex(this.turtleSprite, this.stage.numChildren - 1);
        }
    }
    pxsim.TurtleBoard = TurtleBoard;
    function normalize(a) {
        a %= 360;
        return a > 180 ? a - 360 : a <= -180 ? a + 360 : a;
    }
    const delays = {
        [1 /* Speed.Normal */]: 15,
        [0 /* Speed.Slow */]: 30,
        [2 /* Speed.Fast */]: 1,
        [3 /* Speed.Fastest */]: 0,
    };
    function log(msg) {
        // tslint:disable-next-line:no-console
        console.log(`%c${toLocalISOString(new Date())} %c[TURTLE]`, "color: blue; font-style: italic", "font-weight: bold", msg);
    }
    pxsim.log = log;
    function toLocalISOString(date) {
        const modDate = new Date();
        modDate.setTime(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
        return modDate.toISOString().slice(0, -1);
    }
})(pxsim || (pxsim = {}));
var pxsim;
(function (pxsim) {
    async function createTurtleSprite() {
        return new createjs.Sprite(await turtleSpriteSheet(), "default");
    }
    pxsim.createTurtleSprite = createTurtleSprite;
    async function turtleSpriteSheet() {
        if (turtleSpriteSheet.cached) {
            return turtleSpriteSheet.cached;
        }
        const ssb = new createjs.SpriteSheetBuilder();
        (await loadImages("images/turtle1.svg", "images/turtle2.svg", "images/turtle3.svg")).map((i) => {
            i.regX = 218;
            i.regY = 265;
            ssb.addFrame(i, undefined, 0.06);
        });
        ssb.addAnimation("default", [0, 1, 0, 2], undefined, 0.4);
        turtleSpriteSheet.cached = ssb.build();
        return turtleSpriteSheet.cached;
    }
    (function (turtleSpriteSheet) {
    })(turtleSpriteSheet || (turtleSpriteSheet = {}));
    function loadImages(...sources) {
        return new Promise((resolve, reject) => {
            const queue = new createjs.LoadQueue();
            for (const src of sources) {
                queue.loadFile({ src, type: createjs.LoadQueue.IMAGE });
            }
            queue.addEventListener("error", (e) => {
                queue.removeAllEventListeners("complete");
                reject(e);
            });
            queue.addEventListener("complete", () => {
                resolve(queue.getItems(true).map((i) => new createjs.Bitmap(i.result)));
            });
        });
    }
})(pxsim || (pxsim = {}));
