// 冻结来源 vscode-codex-remote c8c53df41f1cb96cea7f69f59bed362ad03886f1；禁止随最新版自动重生成。
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../../../../private/var/folders/yj/bxvy_gxd31x5nwc40glpwy040000gn/T/remote-freeze-2yp_8siv/bridge/plugin-socket.ts
var plugin_socket_exports = {};
__export(plugin_socket_exports, {
  PluginSocket: () => PluginSocket
});
module.exports = __toCommonJS(plugin_socket_exports);
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
var net = __toESM(require("node:net"));
var import_node_crypto = require("node:crypto");

// ../../../../private/var/folders/yj/bxvy_gxd31x5nwc40glpwy040000gn/T/remote-freeze-2yp_8siv/protocol/command.ts
var ProtocolError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
  code;
};

// ../../../../private/var/folders/yj/bxvy_gxd31x5nwc40glpwy040000gn/T/remote-freeze-2yp_8siv/protocol/plugin-contract.ts
var CURRENT_CAPABILITIES = Object.freeze({
  chat: true,
  controls: true,
  attachments: true,
  actions: true,
  images: true,
  queue: true,
  stream: true
});
var BASIC_CAPABILITIES = Object.freeze({ chat: true });
function readCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const result = { chat: true };
  for (const key of Object.keys(CURRENT_CAPABILITIES)) {
    if (key in value) result[key] = value[key] === true;
  }
  return result;
}
function requiredCapability(operation) {
  switch (operation.kind) {
    case "session.list":
    case "session.snapshot":
    case "turn.stop":
      return "chat";
    case "session.create":
    case "message.send":
      return operation.attachmentIds?.length ? "attachments" : "chat";
    case "session.controls":
      return operation.section === "queue" ? "queue" : "controls";
    case "session.configure":
    case "question.answer":
    case "permission.resolve":
      return "controls";
    case "session.rename":
    case "session.pin":
    case "session.delete":
    case "session.compact":
    case "message.read":
    case "message.edit":
    case "message.regenerate":
      return "actions";
    case "session.image":
      return "images";
    case "message.enqueue":
    case "queue.remove":
    case "queue.resume":
      return "queue";
    default:
      return void 0;
  }
}
function supportsOperation(capabilities, operation) {
  const required = requiredCapability(operation);
  return !!required && capabilities[required] === true && (!operation.attachmentIds?.length || capabilities.attachments === true);
}

// ../../../../private/var/folders/yj/bxvy_gxd31x5nwc40glpwy040000gn/T/remote-freeze-2yp_8siv/bridge/plugin-socket.ts
var validId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
var PluginSocket = class {
  constructor(directory, dispatcher) {
    this.directory = directory;
    this.dispatcher = dispatcher;
    this.socketPath = path.join(directory, "bridge.sock");
    this.configPath = path.join(directory, "bridge.json");
    this.server = net.createServer((socket) => this.accept(socket));
  }
  directory;
  dispatcher;
  server;
  peers = /* @__PURE__ */ new Set();
  token = (0, import_node_crypto.randomBytes)(32).toString("hex");
  socketPath;
  configPath;
  ownsConfig = false;
  ownsSocket = false;
  async listen() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 448 });
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 63) throw new ProtocolError("UNSAFE_PLUGIN_DIRECTORY");
    if (fs.existsSync(this.socketPath)) throw new ProtocolError("PLUGIN_SOCKET_LOCKED");
    let fd;
    try {
      fd = fs.openSync(this.configPath, "wx", 384);
    } catch {
      throw new ProtocolError("PLUGIN_SOCKET_LOCKED");
    }
    this.ownsConfig = true;
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, token: this.token }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      await new Promise((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.socketPath, () => {
          this.server.off("error", reject);
          resolve();
        });
      });
      this.ownsSocket = true;
      fs.chmodSync(this.socketPath, 384);
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  accept(socket) {
    if (this.peers.size >= 16) {
      socket.destroy();
      return;
    }
    this.peers.add(socket);
    const pending = /* @__PURE__ */ new Map();
    let windowId = "", workspaceId = "";
    let capabilities;
    let registered = false, unregister, buffer = Buffer.alloc(0);
    const deadline = setTimeout(() => socket.destroy(), 5e3);
    socket.on("error", () => {
    });
    socket.on("close", () => {
      clearTimeout(deadline);
      unregister?.();
      this.peers.delete(socket);
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject();
      }
      pending.clear();
    });
    const send = (value) => {
      const data = JSON.stringify(value) + "\n";
      if (socket.destroyed || socket.writableLength > 64e3 || Buffer.byteLength(data) > 16e3) throw new Error("IPC_CLOSED");
      socket.write(data);
    };
    const request = (command) => new Promise((resolve, reject) => {
      if (pending.size >= 16) {
        resolve({ accepted: false, error: "PLUGIN_BUSY" });
        return;
      }
      const id = (0, import_node_crypto.randomUUID)();
      const timer = setTimeout(() => socket.destroy(), Math.max(1, Math.min(45e3, command.expiresAt - Date.now())));
      pending.set(id, { resolve, reject: () => reject(new Error("IPC_RESULT_UNKNOWN")), timer });
      try {
        send({ kind: "execute", id, command });
      } catch {
        socket.destroy();
      }
    });
    const learn = (reply) => {
      if (capabilities || !reply.accepted) return;
      const snapshot = reply.result;
      const advertised = readCapabilities(snapshot?.capabilities);
      if (advertised) {
        if (snapshot?.capabilities && !Object.hasOwn(snapshot.capabilities, "attachments")) advertised.attachments = advertised.controls === true;
        capabilities = advertised;
      } else capabilities = { ...BASIC_CAPABILITIES };
    };
    const receive = (frame) => {
      if (!registered) {
        if (frame.kind !== "register" || frame.version !== 1 || typeof frame.token !== "string" || frame.token.length !== this.token.length || !(0, import_node_crypto.timingSafeEqual)(Buffer.from(frame.token), Buffer.from(this.token)) || !validId(frame.windowId) || !validId(frame.workspaceId) || typeof frame.label !== "string" || frame.label.length > 120 || /[\x00-\x1f\x7f]/.test(frame.label)) throw new Error("INVALID_REGISTER");
        if (frame.path !== void 0 && (typeof frame.path !== "string" || frame.path.length > 1024 || /[\x00-\x1f\x7f]/.test(frame.path))) throw new Error("INVALID_REGISTER");
        if (frame.folderCount !== void 0 && (!Number.isSafeInteger(frame.folderCount) || frame.folderCount < 0)) throw new Error("INVALID_REGISTER");
        windowId = frame.windowId;
        workspaceId = frame.workspaceId;
        capabilities = readCapabilities(frame.capabilities);
        unregister = this.dispatcher.register({
          windowId: frame.windowId,
          workspaceId: frame.workspaceId,
          label: frame.label,
          ...typeof frame.path === "string" ? { path: frame.path } : {},
          ...typeof frame.folderCount === "number" ? { folderCount: frame.folderCount } : {},
          execute: async (command) => {
            if (!capabilities && requiredCapability(command.operation) !== "chat" && command.target?.sessionId) {
              const probe = await request({ ...command, operation: { kind: "session.snapshot" } });
              if (!probe.accepted) return probe;
              learn(probe);
            }
            if (!supportsOperation(capabilities ?? BASIC_CAPABILITIES, command.operation))
              return { accepted: false, error: "UNSUPPORTED_FEATURE" };
            const wire = command.operation.kind === "session.create" && !command.operation.attachmentIds?.length ? { ...command, operation: { kind: "session.create", text: command.operation.text } } : command;
            const reply2 = await request(wire);
            if (command.operation.kind === "session.snapshot") learn(reply2);
            return reply2;
          }
        });
        registered = true;
        clearTimeout(deadline);
        send({ kind: "registered", version: 1, features: { events: true } });
        return;
      }
      if (frame.kind === "event") {
        if (!validId(frame.sessionId) || !frame.event || typeof frame.event !== "object" || Array.isArray(frame.event) || Buffer.byteLength(JSON.stringify(frame.event)) > 6500) throw new Error("INVALID_EVENT");
        this.dispatcher.pluginEvent(windowId, workspaceId, frame.sessionId, frame.event);
        return;
      }
      if (frame.kind !== "reply" || !validId(frame.id)) throw new Error("INVALID_REPLY");
      const item = pending.get(frame.id);
      if (!item) throw new Error("UNKNOWN_REPLY");
      const reply = frame.reply;
      if (!reply || typeof reply !== "object" || reply.accepted !== true && reply.accepted !== false || reply.accepted === false && (typeof reply.error !== "string" || !/^[A-Z0-9_]{1,80}$/.test(reply.error)) || Buffer.byteLength(JSON.stringify(reply)) > 7e3) throw new Error("INVALID_REPLY");
      pending.delete(frame.id);
      clearTimeout(item.timer);
      item.resolve(reply);
    };
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      try {
        let end;
        while ((end = buffer.indexOf(10)) >= 0) {
          if (end > 16e3) throw new Error("FRAME_TOO_LARGE");
          const frame = JSON.parse(buffer.subarray(0, end).toString("utf8"));
          buffer = buffer.subarray(end + 1);
          if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("INVALID_FRAME");
          receive(frame);
        }
        if (buffer.length > 16e3) throw new Error("FRAME_TOO_LARGE");
      } catch {
        socket.destroy();
      }
    });
  }
  async close() {
    for (const peer of this.peers) peer.destroy();
    if (this.server.listening) await new Promise((resolve) => this.server.close(() => resolve()));
    if (this.ownsSocket) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
      }
      this.ownsSocket = false;
    }
    if (this.ownsConfig) {
      fs.unlinkSync(this.configPath);
      this.ownsConfig = false;
    }
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PluginSocket
});
