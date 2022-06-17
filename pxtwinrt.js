/// <reference path="./winrtrefs.d.ts"/>
/// <reference path="../built/pxtlib.d.ts"/>
var pxt;
(function (pxt) {
    var winrt;
    (function (winrt) {
        function browserDownloadAsync(text, name, contentType) {
            let file;
            return pxt.winrt.promisify(Windows.Storage.ApplicationData.current.temporaryFolder.createFileAsync(name, Windows.Storage.CreationCollisionOption.replaceExisting)
                .then(f => Windows.Storage.FileIO.writeTextAsync(file = f, text))
                .then(() => Windows.System.Launcher.launchFileAsync(file))
                .then(b => { }));
        }
        winrt.browserDownloadAsync = browserDownloadAsync;
        function saveOnlyAsync(res) {
            const useUf2 = pxt.appTarget.compile.useUF2;
            const fileTypes = useUf2 ? [".uf2"] : [".hex"];
            const savePicker = new Windows.Storage.Pickers.FileSavePicker();
            savePicker.suggestedStartLocation = Windows.Storage.Pickers.PickerLocationId.documentsLibrary;
            savePicker.fileTypeChoices.insert("MakeCode binary file", fileTypes);
            savePicker.suggestedFileName = res.downloadFileBaseName;
            return pxt.winrt.promisify(savePicker.pickSaveFileAsync()
                .then((file) => {
                if (file) {
                    let fileContent = useUf2 ? res.outfiles[pxtc.BINARY_UF2] : res.outfiles[pxtc.BINARY_HEX];
                    if (!pxt.isOutputText()) {
                        fileContent = atob(fileContent);
                    }
                    const ar = [];
                    const bytes = pxt.Util.stringToUint8Array(fileContent);
                    bytes.forEach((b) => ar.push(b));
                    return Windows.Storage.FileIO.writeBytesAsync(file, ar)
                        .then(() => true);
                }
                // Save cancelled
                return Promise.resolve(false);
            }));
        }
        winrt.saveOnlyAsync = saveOnlyAsync;
    })(winrt = pxt.winrt || (pxt.winrt = {}));
})(pxt || (pxt = {}));
/// <reference path="./winrtrefs.d.ts"/>
/// <reference path="../built/pxtlib.d.ts"/>
var pxt;
(function (pxt) {
    var winrt;
    (function (winrt) {
        class WinRTPacketIO {
            constructor() {
                this.onDeviceConnectionChanged = (connect) => { };
                this.onConnectionChanged = () => { };
                this.onData = (v) => { };
                this.onEvent = (v) => { };
                this.onError = (e) => { };
                this.connecting = false;
                this.handleInputReport = this.handleInputReport.bind(this);
            }
            disposeAsync() {
                return Promise.resolve();
            }
            error(msg) {
                throw new Error(pxt.U.lf("USB/HID error ({0})", msg));
            }
            setConnecting(v) {
                this.connecting = v;
                if (this.onConnectionChanged)
                    this.onConnectionChanged();
            }
            isConnecting() {
                return this.connecting;
            }
            isConnected() {
                return !!this.dev;
            }
            reconnectAsync() {
                return this.disconnectAsync()
                    .then(() => this.initAsync());
            }
            isSwitchingToBootloader() {
                expectingAdd = true;
                if (this.dev) {
                    expectingRemove = true;
                }
            }
            disconnectAsync() {
                if (this.dev) {
                    const d = this.dev;
                    delete this.dev;
                    try {
                        d.close();
                    }
                    catch (e) { }
                    if (this.onConnectionChanged)
                        this.onConnectionChanged();
                }
                return Promise.resolve();
            }
            sendPacketAsync(pkt) {
                if (!this.dev)
                    return Promise.resolve();
                const ar = [0];
                for (let i = 0; i < Math.max(pkt.length, 64); ++i)
                    ar.push(pkt[i] || 0);
                const dataWriter = new Windows.Storage.Streams.DataWriter();
                dataWriter.writeBytes(ar);
                const buffer = dataWriter.detachBuffer();
                const report = this.dev.createOutputReport(0);
                report.data = buffer;
                return pxt.winrt.promisify(this.dev.sendOutputReportAsync(report)
                    .then(value => {
                    //pxt.debug(`hf2: ${value} bytes written`)
                }));
            }
            handleInputReport(e) {
                //pxt.debug(`input report`)
                const dr = Windows.Storage.Streams.DataReader.fromBuffer(e.report.data);
                const values = [];
                while (dr.unconsumedBufferLength) {
                    values.push(dr.readByte());
                }
                if (values.length == 65 && values[0] === 0) {
                    values.shift();
                }
                this.onData(new Uint8Array(values));
            }
            initAsync(isRetry = false) {
                pxt.Util.assert(!this.dev, "HID interface not properly reseted");
                const wd = Windows.Devices;
                const whid = wd.HumanInterfaceDevice.HidDevice;
                const rejectDeviceNotFound = () => {
                    const err = new Error(pxt.U.lf("Device not found"));
                    err.type = "devicenotfound";
                    return Promise.reject(err);
                };
                const getDevicesPromise = hidSelectors.reduce((soFar, currentSelector) => {
                    // Try all selectors, in order, until some devices are found
                    return soFar.then((devices) => {
                        if (devices && devices.length) {
                            return Promise.resolve(devices);
                        }
                        return wd.Enumeration.DeviceInformation.findAllAsync(currentSelector, null);
                    });
                }, Promise.resolve(null));
                this.setConnecting(true);
                let deviceId;
                return getDevicesPromise
                    .then((devices) => {
                    if (!devices || !devices[0]) {
                        pxt.debug("no hid device found");
                        return Promise.reject(new Error("no hid device found"));
                    }
                    pxt.debug(`hid enumerate ${devices.length} devices`);
                    const device = devices[0];
                    pxt.debug(`hid connect to ${device.name} (${device.id})`);
                    deviceId = device.id;
                    return whid.fromIdAsync(device.id, Windows.Storage.FileAccessMode.readWrite);
                })
                    .then((r) => {
                    this.dev = r;
                    if (!this.dev) {
                        pxt.debug("can't connect to hid device");
                        let status = Windows.Devices.Enumeration.DeviceAccessInformation.createFromId(deviceId).currentStatus;
                        pxt.reportError("winrt_device", `could not connect to HID device; device status: ${status}`);
                        return Promise.reject(new Error("can't connect to hid device"));
                    }
                    pxt.debug(`hid device version ${this.dev.version}`);
                    this.dev.addEventListener("inputreportreceived", this.handleInputReport);
                    return Promise.resolve();
                })
                    .finally(() => {
                    this.setConnecting(false);
                })
                    .catch((e) => {
                    if (isRetry) {
                        return rejectDeviceNotFound();
                    }
                    return winrt.bootloaderViaBaud(this)
                        .then(() => {
                        return this.initAsync(true);
                    })
                        .catch(() => {
                        return rejectDeviceNotFound();
                    });
                });
            }
        }
        winrt.WinRTPacketIO = WinRTPacketIO;
        winrt.packetIO = undefined;
        function mkWinRTPacketIOAsync() {
            pxt.debug(`packetio: mk winrt packetio`);
            winrt.packetIO = new WinRTPacketIO();
            return winrt.packetIO.initAsync()
                .catch((e) => {
                winrt.packetIO = undefined;
                return Promise.reject(e);
            })
                .then(() => winrt.packetIO);
        }
        winrt.mkWinRTPacketIOAsync = mkWinRTPacketIOAsync;
        const hidSelectors = [];
        const watchers = [];
        let deviceCount = 0;
        let expectingAdd = false;
        let expectingRemove = false;
        function initWinrtHid(reconnectAsync, disconnectAsync) {
            const wd = Windows.Devices;
            const wde = Windows.Devices.Enumeration.DeviceInformation;
            const whid = wd.HumanInterfaceDevice.HidDevice;
            if (pxt.appTarget && pxt.appTarget.compile && pxt.appTarget.compile.hidSelectors) {
                pxt.appTarget.compile.hidSelectors.forEach((s) => {
                    const sel = whid.getDeviceSelector(parseInt(s.usagePage), parseInt(s.usageId), parseInt(s.vid), parseInt(s.pid));
                    if (hidSelectors.indexOf(sel) < 0) {
                        hidSelectors.push(sel);
                    }
                });
            }
            hidSelectors.forEach((s) => {
                const watcher = wde.createWatcher(s, null);
                watcher.addEventListener("added", (e) => {
                    pxt.debug(`new hid device detected: ${e.id}`);
                    if (expectingAdd) {
                        expectingAdd = false;
                    }
                    else {
                        // A new device was plugged in. If it's the first one, then reconnect the UF2 wrapper. Otherwise,
                        // we're already connected to a plugged device, so don't do anything.
                        ++deviceCount;
                        if (deviceCount === 1 && reconnectAsync) {
                            reconnectAsync();
                        }
                    }
                });
                watcher.addEventListener("removed", (e) => {
                    pxt.debug(`hid device closed: ${e.id}`);
                    if (expectingRemove) {
                        expectingRemove = false;
                    }
                    else {
                        // A device was unplugged. If there were more than 1 device, we don't know whether the unplugged
                        // one is the one we were connected to. In that case, reconnect the UF2 wrapper. If no more devices
                        // are left, disconnect the existing wrapper while we wait for a new device to be plugged in.
                        --deviceCount;
                        if (deviceCount > 0 && reconnectAsync) {
                            reconnectAsync();
                        }
                        else if (deviceCount === 0 && disconnectAsync) {
                            disconnectAsync();
                            winrt.packetIO = undefined;
                        }
                    }
                });
                watcher.addEventListener("updated", (e) => {
                    // As per MSDN doc, we MUST subscribe to this event, otherwise the watcher doesn't work
                });
                watchers.push(watcher);
            });
            watchers.filter(w => !w.status).forEach((w) => w.start());
        }
        winrt.initWinrtHid = initWinrtHid;
    })(winrt = pxt.winrt || (pxt.winrt = {}));
})(pxt || (pxt = {}));
/// <reference path="./winrtrefs.d.ts"/>
var pxt;
(function (pxt) {
    var winrt;
    (function (winrt) {
        let watcher;
        let deviceNameFilter;
        let activePorts = {};
        function initSerial() {
            const hasDeviceFilter = !!pxt.appTarget.serial &&
                (!!pxt.appTarget.serial.nameFilter || (!!pxt.appTarget.serial.vendorId && !!pxt.appTarget.serial.productId));
            const canLogSerial = !!pxt.appTarget.serial && pxt.appTarget.serial.log;
            if (!canLogSerial || !hasDeviceFilter)
                return;
            const sd = Windows.Devices.SerialCommunication.SerialDevice;
            let serialDeviceSelector;
            if (!pxt.appTarget.serial.vendorId || !pxt.appTarget.serial.productId) {
                deviceNameFilter = new RegExp(pxt.appTarget.serial.nameFilter);
                serialDeviceSelector = sd.getDeviceSelector();
            }
            else {
                serialDeviceSelector = sd.getDeviceSelectorFromUsbVidPid(parseInt(pxt.appTarget.serial.vendorId), parseInt(pxt.appTarget.serial.productId));
            }
            // Create a device watcher to look for instances of the Serial device
            // As per MSDN doc, to use the correct overload, we pass null as 2nd argument
            watcher = Windows.Devices.Enumeration.DeviceInformation.createWatcher(serialDeviceSelector, null);
            watcher.addEventListener("added", deviceAdded);
            watcher.addEventListener("removed", deviceRemoved);
            watcher.addEventListener("updated", deviceUpdated);
            watcher.start();
        }
        winrt.initSerial = initSerial;
        function suspendSerialAsync() {
            if (watcher) {
                watcher.stop();
                watcher.removeEventListener("added", deviceAdded);
                watcher.removeEventListener("removed", deviceRemoved);
                watcher.removeEventListener("updated", deviceUpdated);
                watcher = undefined;
            }
            let stoppedReadingOpsPromise = Promise.resolve();
            Object.keys(activePorts).forEach((deviceId) => {
                const port = activePorts[deviceId];
                const currentRead = port.readingOperation;
                if (currentRead) {
                    const deferred = pxt.Util.defer();
                    port.cancellingDeferred = deferred;
                    stoppedReadingOpsPromise = stoppedReadingOpsPromise.then(() => {
                        return pxt.U.promiseTimeout(500, deferred.promise)
                            .catch((e) => {
                            pxt.reportError("winrt_device", `could not cancel reading operation for a device: ${e.message}`);
                        });
                    });
                    currentRead.cancel();
                }
            });
            return stoppedReadingOpsPromise
                .then(() => {
                Object.keys(activePorts).forEach((deviceId) => {
                    const port = activePorts[deviceId];
                    if (port.device) {
                        const device = port.device;
                        device.close();
                    }
                });
                activePorts = {};
            });
        }
        winrt.suspendSerialAsync = suspendSerialAsync;
        /**
         * Most Arduino devices support switching into bootloader by opening the COM port at 1200 baudrate.
         */
        function bootloaderViaBaud(io) {
            if (!pxt.appTarget || !pxt.appTarget.compile || !pxt.appTarget.compile.useUF2 ||
                !pxt.appTarget.simulator || !pxt.appTarget.simulator.boardDefinition || !pxt.appTarget.simulator.boardDefinition.bootloaderBaudSwitchInfo) {
                return Promise.reject(new Error("device does not support switching to bootloader via baudrate"));
            }
            let allSerialDevices;
            const vidPidInfo = pxt.appTarget.simulator.boardDefinition.bootloaderBaudSwitchInfo;
            const selector = {
                vid: vidPidInfo.vid,
                pid: vidPidInfo.pid,
                usageId: undefined,
                usagePage: undefined
            };
            return connectSerialDevicesAsync([selector])
                .then((serialDevices) => {
                if (!serialDevices || serialDevices.length === 0) {
                    // No device found, it really looks like no device is plugged in. Bail out.
                    return Promise.reject(new Error("no serial devices to switch into bootloader"));
                }
                allSerialDevices = serialDevices;
                if (allSerialDevices.length) {
                    io.isSwitchingToBootloader();
                }
                allSerialDevices.forEach((dev) => {
                    dev.baudRate = 1200;
                    dev.close();
                });
                // A long delay is needed before attempting to connect to the bootloader device, enough for the OS to
                // recognize the device has been plugged in. Without drivers, connection to the device might still fail
                // the first time, but drivers should be installed by the time the user clicks Download again, at which
                // point flashing will work without the user ever needing to manually set the device to bootloader
                return pxt.U.delay(1500);
            });
        }
        winrt.bootloaderViaBaud = bootloaderViaBaud;
        /**
         * Connects to all matching serial devices without initializing the full PXT serial stack. Returns the list of
         * devices that were successfully connected to, but doesn't do anything with these devices.
         */
        function connectSerialDevicesAsync(hidSelectors) {
            if (!hidSelectors) {
                return Promise.resolve([]);
            }
            const wd = Windows.Devices;
            const sd = wd.SerialCommunication.SerialDevice;
            const di = wd.Enumeration.DeviceInformation;
            const serialDeviceSelectors = [];
            hidSelectors.forEach((s) => {
                const sel = sd.getDeviceSelectorFromUsbVidPid(parseInt(s.vid), parseInt(s.pid));
                serialDeviceSelectors.push(sel);
            });
            const allDevicesPromise = serialDeviceSelectors.reduce((promiseSoFar, sel) => {
                let deviceInfoSoFar;
                return promiseSoFar
                    .then((diSoFar) => {
                    deviceInfoSoFar = diSoFar;
                    return di.findAllAsync(sel, null);
                })
                    .then((foundDevices) => {
                    if (deviceInfoSoFar) {
                        for (let i = 0; i < foundDevices.length; ++i) {
                            deviceInfoSoFar.push(foundDevices[i]);
                        }
                    }
                    else {
                        deviceInfoSoFar = foundDevices;
                    }
                    return Promise.resolve(deviceInfoSoFar);
                });
            }, Promise.resolve(null));
            return allDevicesPromise
                .then((allDeviceInfo) => {
                if (!allDeviceInfo) {
                    return Promise.resolve([]);
                }
                return pxt.U.promiseMapAll(allDeviceInfo, (devInfo) => {
                    return pxt.winrt.promisify(sd.fromIdAsync(devInfo.id));
                });
            });
        }
        winrt.connectSerialDevicesAsync = connectSerialDevicesAsync;
        function deviceAdded(deviceInfo) {
            if (deviceNameFilter && !deviceNameFilter.test(deviceInfo.name)) {
                return;
            }
            pxt.debug(`serial port added ${deviceInfo.name} - ${deviceInfo.id}`);
            activePorts[deviceInfo.id] = {
                info: deviceInfo
            };
            Windows.Devices.SerialCommunication.SerialDevice.fromIdAsync(deviceInfo.id)
                .then((dev) => {
                activePorts[deviceInfo.id].device = dev;
                startDevice(deviceInfo.id);
            });
        }
        function deviceRemoved(deviceInfo) {
            delete activePorts[deviceInfo.id];
        }
        function deviceUpdated(deviceInfo) {
            const port = activePorts[deviceInfo.id];
            if (port) {
                port.info.update(deviceInfo);
            }
        }
        let readingOpsCount = 0;
        function startDevice(id) {
            let port = activePorts[id];
            if (!port)
                return;
            if (!port.device) {
                let status = Windows.Devices.Enumeration.DeviceAccessInformation.createFromId(id).currentStatus;
                pxt.reportError("winrt_device", `could not connect to serial device; device status: ${status}`);
                return;
            }
            const streams = Windows.Storage.Streams;
            port.device.baudRate = 115200;
            let stream = port.device.inputStream;
            let reader = new streams.DataReader(stream);
            reader.inputStreamOptions = streams.InputStreamOptions.partial;
            let serialBuffers = {};
            let readMore = () => {
                // Make sure the device is still active
                if (!activePorts[id] || !!port.cancellingDeferred) {
                    return;
                }
                port.readingOperation = reader.loadAsync(32);
                port.readingOperation.then((bytesRead) => {
                    let msg = reader.readString(Math.floor(reader.unconsumedBufferLength / 4) * 4);
                    pxt.Util.bufferSerial(serialBuffers, msg, id);
                    setTimeout(() => readMore(), 1);
                }, (e) => {
                    const status = port.readingOperation.operation.status;
                    if (status === Windows.Foundation.AsyncStatus.canceled) {
                        reader.detachStream();
                        reader.close();
                        if (port.cancellingDeferred) {
                            setTimeout(() => port.cancellingDeferred.resolve(), 25);
                        }
                    }
                    else {
                        setTimeout(() => startDevice(id), 1000);
                    }
                });
            };
            setTimeout(() => readMore(), 100);
        }
    })(winrt = pxt.winrt || (pxt.winrt = {}));
})(pxt || (pxt = {}));
/// <reference path="./winrtrefs.d.ts"/>
var pxt;
(function (pxt) {
    var winrt;
    (function (winrt) {
        pxt.BrowserUtils.isWinRT = isWinRT;
        function promisify(p) {
            return new Promise((resolve, reject) => {
                p.then(v => resolve(v), e => reject(e));
            });
        }
        winrt.promisify = promisify;
        function toArray(v) {
            let r = [];
            let length = v.length;
            for (let i = 0; i < length; ++i)
                r.push(v[i]);
            return r;
        }
        winrt.toArray = toArray;
        /**
         * Detects if the script is running in a browser on windows
         */
        function isWindows() {
            return !!navigator && /Win32/i.test(navigator.platform);
        }
        winrt.isWindows = isWindows;
        function isWinRT() {
            return typeof Windows !== "undefined";
        }
        winrt.isWinRT = isWinRT;
        function initAsync(importHexImpl) {
            if (!isWinRT() || pxt.BrowserUtils.isIFrame())
                return Promise.resolve();
            const uiCore = Windows.UI.Core;
            const navMgr = uiCore.SystemNavigationManager.getForCurrentView();
            const app = Windows.UI.WebUI.WebUIApplication;
            app.addEventListener("suspending", suspendingHandler);
            app.addEventListener("resuming", resumingHandler);
            navMgr.onbackrequested = (e) => {
                // Ignore the built-in back button; it tries to back-navigate the sidedoc panel, but it crashes the
                // app if the sidedoc has been closed since the navigation happened
                pxt.log("BACK NAVIGATION");
                navMgr.appViewBackButtonVisibility = uiCore.AppViewBackButtonVisibility.collapsed;
                e.handled = true;
            };
            winrt.initSerial();
            return hasActivationProjectAsync()
                .then(() => {
                if (importHexImpl) {
                    importHex = importHexImpl;
                    app.removeEventListener("activated", initialActivationHandler);
                    app.addEventListener("activated", fileActivationHandler);
                }
            });
        }
        winrt.initAsync = initAsync;
        // Needed for when user double clicks a hex file without the app already running
        function captureInitialActivation() {
            if (!isWinRT()) {
                return;
            }
            initialActivationDeferred = pxt.Util.defer();
            const app = Windows.UI.WebUI.WebUIApplication;
            app.addEventListener("activated", initialActivationHandler);
        }
        winrt.captureInitialActivation = captureInitialActivation;
        function loadActivationProject() {
            return initialActivationDeferred.promise
                .then((args) => fileActivationHandler(args, /* openHomeIfFailed */ true));
        }
        winrt.loadActivationProject = loadActivationProject;
        function hasActivationProjectAsync() {
            if (!isWinRT()) {
                return Promise.resolve(false);
            }
            // By the time the webapp calls this, if the activation promise hasn't been settled yet, assume we missed the
            // activation event and pretend there were no activation args
            initialActivationDeferred.resolve(null); // This is no-op if the promise had been previously resolved
            return initialActivationDeferred.promise
                .then((args) => {
                return Promise.resolve(args && args.kind === Windows.ApplicationModel.Activation.ActivationKind.file);
            });
        }
        winrt.hasActivationProjectAsync = hasActivationProjectAsync;
        function releaseAllDevicesAsync() {
            if (!isWinRT()) {
                return Promise.resolve();
            }
            return Promise.resolve()
                .then(() => {
                if (winrt.packetIO) {
                    pxt.log(`disconnecting packetIO`);
                    return winrt.packetIO.disconnectAsync();
                }
                return Promise.resolve();
            })
                .catch((e) => {
                e.message = `error disconnecting packetIO: ${e.message}`;
                pxt.reportException(e);
            })
                .then(() => {
                pxt.log("suspending serial");
                return winrt.suspendSerialAsync();
            })
                .catch((e) => {
                e.message = `error suspending serial: ${e.message}`;
                pxt.reportException(e);
            });
        }
        winrt.releaseAllDevicesAsync = releaseAllDevicesAsync;
        function initialActivationHandler(args) {
            Windows.UI.WebUI.WebUIApplication.removeEventListener("activated", initialActivationHandler);
            initialActivationDeferred.resolve(args);
        }
        function suspendingHandler(args) {
            pxt.log(`suspending`);
            const suspensionDeferral = args.suspendingOperation.getDeferral();
            return releaseAllDevicesAsync()
                .then(() => suspensionDeferral.complete(), (e) => suspensionDeferral.complete())
                .then();
        }
        function resumingHandler(args) {
            pxt.log(`resuming`);
            if (winrt.packetIO) {
                pxt.log(`reconnet pack io`);
                winrt.packetIO.reconnectAsync();
            }
            winrt.initSerial();
        }
        let initialActivationDeferred;
        let importHex;
        function fileActivationHandler(args, openHomeIfFailed = false) {
            if (args.kind === Windows.ApplicationModel.Activation.ActivationKind.file) {
                let info = args;
                let file = info.files.getAt(0);
                if (file && file.isOfType(Windows.Storage.StorageItemTypes.file)) {
                    let f = file;
                    Windows.Storage.FileIO.readBufferAsync(f)
                        .then(buffer => {
                        let ar = [];
                        let dataReader = Windows.Storage.Streams.DataReader.fromBuffer(buffer);
                        while (dataReader.unconsumedBufferLength) {
                            ar.push(dataReader.readByte());
                        }
                        dataReader.close();
                        return pxt.cpp.unpackSourceFromHexAsync(new Uint8Array(ar));
                    })
                        .then((hex) => importHex(hex, { openHomeIfFailed }));
                }
            }
        }
    })(winrt = pxt.winrt || (pxt.winrt = {}));
})(pxt || (pxt = {}));
/// <reference path="../built/pxtlib.d.ts"/>
/// <reference path="../built/pxteditor.d.ts"/>
/// <reference path="./winrtrefs.d.ts"/>
var pxt;
(function (pxt) {
    var winrt;
    (function (winrt) {
        var workspace;
        (function (workspace) {
            var U = pxt.Util;
            let folder;
            function fileApiAsync(path, data) {
                if (U.startsWith(path, "pkg/")) {
                    let id = path.slice(4);
                    if (data) {
                        return writePkgAsync(id, data);
                    }
                    else {
                        return readPkgAsync(id, true);
                    }
                }
                else if (path == "list") {
                    return initAsync()
                        .then(listPkgsAsync);
                }
                else {
                    throw throwError(404);
                }
            }
            workspace.fileApiAsync = fileApiAsync;
            function initAsync() {
                if (folder)
                    return Promise.resolve();
                const applicationData = Windows.Storage.ApplicationData.current;
                const localFolder = applicationData.localFolder;
                pxt.debug(`winrt: initializing workspace`);
                return winrt.promisify(localFolder.createFolderAsync(pxt.appTarget.id, Windows.Storage.CreationCollisionOption.openIfExists))
                    .then(fd => {
                    folder = fd;
                    pxt.debug(`winrt: initialized workspace at ${folder.path}`);
                }).then(() => { });
            }
            function pathjoin(...parts) {
                return parts.join('\\');
            }
            function readFileAsync(path) {
                const fp = pathjoin(folder.path, path);
                pxt.debug(`winrt: reading ${fp}`);
                return winrt.promisify(Windows.Storage.StorageFile.getFileFromPathAsync(fp)
                    .then(file => Windows.Storage.FileIO.readTextAsync(file)));
            }
            function writeFileAsync(dir, name, content) {
                const fd = pathjoin(folder.path, dir);
                pxt.debug(`winrt: writing ${pathjoin(fd, name)}`);
                return winrt.promisify(Windows.Storage.StorageFolder.getFolderFromPathAsync(fd))
                    .then(dk => dk.createFileAsync(name, Windows.Storage.CreationCollisionOption.replaceExisting))
                    .then(f => Windows.Storage.FileIO.writeTextAsync(f, content))
                    .then(() => { });
            }
            function statOptAsync(path) {
                const fn = pathjoin(folder.path, path);
                pxt.debug(`winrt: ${fn}`);
                return winrt.promisify(Windows.Storage.StorageFile.getFileFromPathAsync(fn)
                    .then(file => file.getBasicPropertiesAsync()
                    .then(props => {
                    return {
                        name: path,
                        mtime: props.dateModified.getTime()
                    };
                })));
            }
            function throwError(code, msg = null) {
                let err = new Error(msg || "Error " + code);
                err.statusCode = code;
                throw err;
            }
            const HEADER_JSON = ".header.json";
            function writePkgAsync(logicalDirname, data) {
                pxt.debug(`winrt: writing package at ${logicalDirname}`);
                return winrt.promisify(folder.createFolderAsync(logicalDirname, Windows.Storage.CreationCollisionOption.openIfExists))
                    .then(() => U.promiseMapAll(data.files, f => readFileAsync(pathjoin(logicalDirname, f.name))
                    .then(text => {
                    if (f.name == pxt.SIMSTATE_JSON || f.name == pxt.ASSETS_FILE)
                        return; // ignore conflicts in sim or assets internal file
                    else if (f.name == pxt.CONFIG_NAME) {
                        try {
                            let cfg = JSON.parse(f.content);
                            if (!cfg.name) {
                                pxt.log("Trying to save invalid JSON config");
                                throwError(410);
                            }
                        }
                        catch (e) {
                            pxt.log("Trying to save invalid format JSON config");
                            throwError(410);
                        }
                    }
                    if (text !== f.prevContent) {
                        pxt.log(`merge error for ${f.name}: previous content changed...`);
                        throwError(409);
                    }
                }, err => { })))
                    // no conflict, proceed with writing
                    .then(() => U.promiseMapAll(data.files, f => writeFileAsync(logicalDirname, f.name, f.content)))
                    .then(() => writeFileAsync(logicalDirname, HEADER_JSON, JSON.stringify(data.header, null, 4)))
                    .then(() => readPkgAsync(logicalDirname, false));
            }
            function readPkgAsync(logicalDirname, fileContents) {
                pxt.debug(`winrt: reading package under ${logicalDirname}`);
                return readFileAsync(pathjoin(logicalDirname, pxt.CONFIG_NAME))
                    .then(text => {
                    const cfg = JSON.parse(text);
                    return U.promiseMapAll(pxt.allPkgFiles(cfg), fn => statOptAsync(pathjoin(logicalDirname, fn))
                        .then(st => {
                        const rf = {
                            name: fn,
                            mtime: st ? st.mtime : null
                        };
                        if (st == null || !fileContents)
                            return rf;
                        else
                            return readFileAsync(pathjoin(logicalDirname, fn))
                                .then(text => {
                                rf.content = text;
                                return rf;
                            });
                    }))
                        .then(files => {
                        const rs = {
                            path: logicalDirname,
                            header: null,
                            config: cfg,
                            files: files
                        };
                        return readFileAsync(pathjoin(logicalDirname, HEADER_JSON))
                            .then(text => {
                            if (text)
                                rs.header = JSON.parse(text);
                        }, e => { })
                            .then(() => rs);
                    });
                });
            }
            function listPkgsAsync() {
                return winrt.promisify(folder.getFoldersAsync())
                    .then((fds) => U.promiseMapAll(fds, (fd) => readPkgAsync(fd.name, false)))
                    .then((fsPkgs) => {
                    return Promise.resolve({ pkgs: fsPkgs });
                });
            }
            function resetAsync() {
                return winrt.promisify(folder.deleteAsync(Windows.Storage.StorageDeleteOption.default)
                    .then(() => {
                    folder = undefined;
                }));
            }
            function getProvider(base) {
                let r = {
                    listAsync: base.listAsync,
                    getAsync: base.getAsync,
                    setAsync: base.setAsync,
                    resetAsync,
                };
                return r;
            }
            workspace.getProvider = getProvider;
        })(workspace = winrt.workspace || (winrt.workspace = {}));
    })(winrt = pxt.winrt || (pxt.winrt = {}));
})(pxt || (pxt = {}));
