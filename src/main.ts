/*
	kwin-script: kwin-pretty-maximize
	Author: arbitar <kwin-pretty-maximize@arbi.in>
*/

//
// global types
//

type PadSpec = { left: number, right: number, top: number, bottom: number };

class Config {
	public constructor() { 
		this._padding = {
			left: readConfig("padding-left", 16),
			right: readConfig("padding-right", 16),
			top: readConfig("padding-top", 16),
			bottom: readConfig("padding-bottom", 16 + 64)
		};
		this._allowUpgrade = readConfig("allow-upgrade", true);
		this._applyAutomatically = readConfig("apply-automatically", true);
		this._ignore = readConfig("ignore-apps", "").toLowerCase().split("\n");
		this._force = readConfig("force-apps", "").toLowerCase().split("\n");
	}

	public static Regenerate(): Config {
		return new Config();
	}

	private _padding: PadSpec;
	public get padding() { return this._padding }

	private _allowUpgrade: boolean;
	public get allowUpgrade() { return this._allowUpgrade }

	private _applyAutomatically: boolean;
	public get applyAutomatically() { return this._applyAutomatically }

	private _ignore: string[];
	public get ignore() { return this._ignore }

	private _force: string[];
	public get force() { return this._force }
}

// window state bitfield, for tracking
// examples:
// PADDED|MAXIMIZED = maximized with padding
// QT_LEFT|QT_BOTTOM = fully bottom-left quicktiled without padding (to edge of screen)
// PADDED|QT_TOP|QT_RIGHT = bottom-right quicktiled with padding
enum State {
	PADDED =	 		0b1_00000_00, // if this state is the "padded form"

	FREE = 				0b0_00000_00, // not maximized or quicktiled
	MAXIMIZED_H =	0b0_00000_01, // maximized horizontally (unused for now)
	MAXIMIZED_V =	0b0_00000_10, // maximized vertically (unused for now)
	MAXIMIZED =		0b0_00000_11, // maximized (both H|V)

	QUICKTILED = 	0b0_10000_00, // in quicktile mode
	QT_LEFT =			0b0_11000_00, // quicktiled left
	QT_RIGHT =		0b0_10100_00, // .. right
	QT_BOTTOM =		0b0_10010_00, // .. bottom
	QT_TOP =			0b0_10001_00, // .. top

	// hack pls ignore
	QT_ANY =					0b0_11111_00,
	QT_TOPLEFT =			0b0_11001_00,
	QT_TOPRIGHT =			0b0_10101_00,
	QT_BOTTOMLEFT =		0b0_11010_00,
	QT_BOTTOMRIGHT =	0b0_10110_00,
};

type QuicktileBoundsCollection = {
	[State.QT_TOPLEFT]: QRect,
	[State.QT_TOP]: QRect,
	[State.QT_TOPRIGHT]: QRect,
	[State.QT_LEFT]: QRect,
	[State.QT_RIGHT]: QRect,
	[State.QT_BOTTOMLEFT]: QRect,
	[State.QT_BOTTOM]: QRect,
	[State.QT_BOTTOMRIGHT]: QRect
}

const QT_ZONES_CARDINAL = [
	State.QT_LEFT,
	State.QT_RIGHT,
	State.QT_BOTTOM,
	State.QT_TOP
];

const QT_ZONES_ALL = [
	...QT_ZONES_CARDINAL,
	State.QT_TOP|State.QT_LEFT,
	State.QT_TOP|State.QT_RIGHT,
	State.QT_BOTTOM|State.QT_LEFT,
	State.QT_BOTTOM|State.QT_RIGHT
];

interface BitfieldChange {
	rising: number
	falling: number
	same: number
	different: number

	rose(x: number): boolean;
	fell(x: number): boolean;
	remained(x: number): boolean;
	changed(x: number): boolean;

	was(x: number): boolean;
	now(x: number): boolean;
};

//
// global functions
//

function bf_isset(bf: number, flag: number): boolean {
	return ((bf & flag) === flag);
}

function bf_analyze_change(oldBf: number, newBf: number): BitfieldChange {
	const different = oldBf ^ newBf;
	const [same, rising, falling] = [
		oldBf & newBf,
		different & (~oldBf & 0),
		different & (~newBf & 0)
	];

	return {
		rising, falling, same, different,

		rose: (x) => bf_isset(rising, x),
		fell: (x) => bf_isset(rising, x),
		remained: (x) => bf_isset(rising, x),
		changed: (x) => bf_isset(rising, x),

		was: (x) => bf_isset(oldBf, x),
		now: (x) => bf_isset(newBf, x)
	}
}

// invert the direction of any quicktiles
// ... might behave weird if opposing directions are given
function qt_invert(state: State) {
	return (state & ~State.QT_ANY) | (
		  (bf_isset(state, State.QT_LEFT) ? State.QT_RIGHT : 0)
		| (bf_isset(state, State.QT_RIGHT) ? State.QT_LEFT : 0)
		| (bf_isset(state, State.QT_TOP) ? State.QT_BOTTOM : 0)
		| (bf_isset(state, State.QT_BOTTOM) ? State.QT_TOP : 0)
	);
}

// turn a kclient's position in to a qrect
function kclient_qrect({x, y, width, height}: KWin.AbstractClient): QRect {
	return {
		x, y,
		width, height
	};
}

// compare qrects
function qrect_eq(a: QRect, b: QRect): boolean {
	return (
		a.x === b.x
		&& a.y === b.y
		&& a.width === b.width
		&& a.height === b.height
	);
}

// takes a (presumably unpadded) qrect and applies specified padding
function qrect_pad(rect: QRect, padding: PadSpec): QRect {
	return {
		x: rect.x + padding.left,
    y: rect.y + padding.top,
    width: rect.width - (padding.left + padding.right),
    height: rect.height - (padding.top + padding.bottom)
	};
}

// takes a (presumably padded) qrect and unpads it
function qrect_unpad(rect: QRect, padding: PadSpec): QRect {
	return {
		x: rect.x - padding.left,
		y: rect.y - padding.top,
		width: rect.width + padding.left + padding.right,
		height: rect.height + padding.top + padding.bottom
	};
}

// slice a qrect into a quicktile section specified by slice
function qrect_qtile(rect: QRect, slice: State): QRect {
	let height = rect.height;
	let width = rect.width;

	if (bf_isset(slice, State.QT_LEFT) || bf_isset(slice, State.QT_RIGHT)) {
		width *= 0.5;
	}

	if (bf_isset(slice, State.QT_TOP) || bf_isset(slice, State.QT_BOTTOM)){ 
		height *= 0.5;
	}

	let x = rect.x;
	let y = rect.y;

	if (bf_isset(slice, State.QT_RIGHT)) {
		x += rect.width * 0.5;
	}

	if (bf_isset(slice, State.QT_BOTTOM)) {
		y += rect.height * 0.5;
	}

	return {
		x, y,
		width, height
	};
}

//
// client manager implementation
//

class ClientManager {
	public constructor(workspace: KWin.QtScriptWorkspaceWrapper) {
		this._workspace = workspace;
		this._config = Config.Regenerate();
	}

	private _workspace: KWin.QtScriptWorkspaceWrapper;
	public get workspace() { return this._workspace; }

	private _config: Config;
	public get config() { return this._config; }

	private _clients: { [id: number]: Client } = {}
	public get clients() { return this._clients; }

	public init() {
		this.workspace.clientList().forEach(this.add.bind(this));
		this.workspace.clientAdded.connect(this.add.bind(this));
		this.workspace.clientRemoved.connect(this.remove.bind(this));
	}

	public regenerateConfig() {
		this._config = Config.Regenerate();
		Object.values(this._clients).forEach(c => c.config = this._config);
	}

	public get(id: number): Client|false {
		return this._clients[id] ?? false;
	}

	private add(kclient: KWin.AbstractClient): number {
		const client = new Client(this, kclient, this.config);
		this.clients[client.id] = client;
		return client.id;
	}
	
	private remove(kclient: KWin.AbstractClient): void {
		const id = Client.get_id_for(kclient);
		if (this.clients[id]) {
			delete this._clients[id];
		}
	}
}

//
// client implementation
//

class Client {
	public constructor(manager: ClientManager, client: KWin.AbstractClient, config: Config) {
		this._manager = manager;
		this._kclient = client;
		this._config = config;

		this.recalculateBounds();
	}

	public static get_id_for(kclient: KWin.AbstractClient) {
		return kclient.windowId;
	}

	private _manager: ClientManager;
	public get manager() { return this._manager; }

	private _kclient: KWin.AbstractClient;
	public get kclient() { return this._kclient; }

	private _config: Config;
	public get config() { return this._config; }
	public set config(newConfig: Config) {
		this._config = newConfig;
		this.recalculateBounds();
	}

	private _state: State = State.FREE;
	public get state() { return this._state; }
	public set state(newState: State) {
		const oldState = this._state;
		this._state = newState;
		this.handleRawStateChange(oldState, newState);
	}

	public get id() { return Client.get_id_for(this.kclient) }

	private _bounds!: QRect;
	protected get bounds() { return this._bounds; }

	private _qtBounds!: QuicktileBoundsCollection;
	protected get qtBounds() { return this._qtBounds; }

	private _padBounds!: QRect;
	protected get padBounds() { return this._padBounds; }

	private _padQtBounds!: QuicktileBoundsCollection;
	protected get padQtBounds() { return this._padQtBounds; }

	public init() {
		// get initial state by guessing
		this._state = this.guessState();

		this.kclient.clientMaximizedStateChanged.connect(this.handleClientMaximizedStateChange.bind(this));
		this.kclient.clientGeometryChanged.connect(this.handleClientGeometryChanged.bind(this));
		this.kclient.frameGeometryChanged.connect(this.handleFrameGeometryChanged.bind(this));
		this.kclient.clientFinishUserMovedResized.connect(this.handleMoveResized.bind(this));
		this.kclient.quickTileModeChanged.connect(this.handleQuickTileModeChanged.bind(this));
	}

	private recalculateBounds() {
		this._bounds = this.manager.workspace.clientArea(
			KWin.WorkspaceWrapper.ClientAreaOption.MaximizeArea,
			this._kclient);
			
		this._padBounds = qrect_pad(this._bounds, this.manager.config.padding);

		this._qtBounds = QT_ZONES_ALL
			.reduce((acc, zone) => {
				acc[zone] = qrect_qtile(this._bounds, zone);
			}, {} as any);

		this._padQtBounds = QT_ZONES_ALL
			.reduce((acc, zone) => {
				acc[zone] = qrect_qtile(this._padBounds, zone);
			}, {} as any);
	}

	private handleMoveResized() {
		// window finished being moved or resized
		this.state = this.guessState();
	}

	private handleClientMaximizedStateChange(_client: KWin.AbstractClient, maximizeMode: KWin.MaximizeMode) {
		// window true maximized or true unmaximized

		if (maximizeMode === KWin.MaximizeMode.MaximizeFull) {
			// straight-up maximized
			this.state = State.MAXIMIZED;
			return;
		}

		if (maximizeMode === KWin.MaximizeMode.MaximizeRestore) {
			// TODO: determine if there are edges to this case?
			this.state = State.FREE;
			return;
		}
	}

	private handleClientGeometryChanged(topLevel: KWin.Toplevel, oldGeometry: QRect) {
		// window geometry changed
		this.state = this.guessState();
	}

	private handleFrameGeometryChanged() {
		// frame geometry changed...
		// handle new states
		this.state = this.guessState();
	}

	private handleQuickTileModeChanged() {
		// quicktile mode changed
		this.state = this.guessState();
	}

	// guess the state of the window given its current real position & size
	private guessState(): State {
		const bounds = this._bounds;
		const padBounds = this._padBounds;
		const client = this._kclient;

		// check if any edge of the client touches upon any expected
		// x or y rules for maximized or micromaximized windows
		const anyAlignment = (
			client.x === bounds.x || client.y === bounds.y
			|| (client.x + client.width) === (bounds.x + bounds.width)
			|| (client.x + client.width) === (bounds.x + bounds.width)
			
			|| client.x === padBounds.x || client.y === padBounds.y
			|| (client.x + client.width) === (padBounds.x + padBounds.width)
			|| (client.y + client.height) === (padBounds.y + padBounds.height)
		);

		if (!anyAlignment) {
			// doesn't lie upon any valid maximize or quicktile 'line'.
			// must be free...
			return State.FREE;
		}

		// there was alignment of some kind... let's be more explicit
		// in checking here.

		const clientBounds = kclient_qrect(client);

		if (qrect_eq(clientBounds, bounds)) {
			// true maximized short-circuit
			return State.MAXIMIZED;
		}

		if(qrect_eq(clientBounds, padBounds)) {
			// micromaximized short-circuit
			return State.PADDED|State.MAXIMIZED;
		}

		// check each quicktile possibility...
		for (const qtConfig of QT_ZONES_ALL) {
			// TODO: revisit this with new precalculated quicktile bounds??
			//       probably no need to do a qrect_qtile every time...

			const qtBounds = qrect_qtile(bounds, qtConfig);
			if (qrect_eq(clientBounds, qtBounds)) {
				// true quicktile
				return qtConfig;
			}

			const qtPadBounds = qrect_qtile(padBounds, qtConfig);
			if (qrect_eq(clientBounds, qtPadBounds)) {
				// padded quicktile
				return State.PADDED|qtConfig;
			}
		}

		// had no line alignment...
		// wasn't maximized...
		// wasn't micromaximized...
		// wasn't quicktiled or microquicktiled...
		// it must be
		return State.FREE;
	}

	private setRealWindowTo(state: State = this.state) {
		if (bf_isset(state, State.MAXIMIZED) && bf_isset(~state, State.PADDED)) {
			// true maximize; just do that!
			this.kclient.setMaximize(true, true);
			return;
		}

		let baseBounds = (bf_isset(state, State.PADDED) ? this.padBounds : this.bounds);

		if (bf_isset(state, State.QUICKTILED)) {
			let bounds = qrect_qtile(baseBounds, state);
			this.kclient.frameGeometry = bounds;
		}
	}

	private handleRawStateChange(oldSt: State, newSt: State): void {
		const change = bf_analyze_change(oldSt, newSt);
		const {
			rose, fell, remained, changed, was, now
		} = change;

		// desired maximization behavior:
		// maximize once, go to padded maximize
		// maximize again from padded maximize, promote to real maximize
		/* examples:
			(1) non-max start (s=FREE)
			(2) recv MAX to padded MAX (s=PAD|MAX)
			(3) recv MAX again to real MAX (s=MAX)
		*/
		if (now(State.MAXIMIZED)) {
			// window was prompted to true-maximize

			if (fell(State.PADDED) && remained(State.MAXIMIZED)) {
				// just left micro-maximized state
				return; // do nothing. allow this maximize
			}

			// if it didn't just come from micro-maximized,
			// then micro-maximize it
			this.setRealWindowTo(State.PADDED | State.MAXIMIZED);
			return;
		}

		// desired quicktile behavior:
		// quicktile once, go to padded quicktile
		// quicktile again from padded quicktile, promote to real quicktile
		/* examples:
			(1) non-QT start (s=FREE/MAX)
			(2) recv QT_L to padded QT_L (s=PAD|QT|QT_L)
			(3) recv QT_L again to real QT_L (s=QT|QT_L)

			(1) non-QT start (s=FREE/MAX)
			(2) recv QTL to padded QT_L (s=PAD|QT|QT_L)
			(3) recv QTT to padded QT_TL (s=PAD|QT|QT_L|QT_T)
			(4) recv QTT|QTL again to real QT_TL (s=QT|QT_L|QT_T)
		*/
		if (now(State.QUICKTILED)) {
			// window was just prompted to quicktile!
			// (warn: possibly from another quicktile state)

			if (!was(State.QUICKTILED)) {
				// if this wasn't quicktiled already, then just pad to the new direction we got
				this.setRealWindowTo(State.PADDED | (newSt & State.QT_ANY));
				return;
			}

			// we came from another quicktile state...

			// was it an opposite quicktile state?
			const oppositeMove = (
						(fell(State.QT_LEFT) && rose(State.QT_RIGHT))
				|| (fell(State.QT_RIGHT) && rose(State.QT_LEFT))
				|| (fell(State.QT_BOTTOM) && rose(State.QT_TOP))
				|| (fell(State.QT_TOP) && rose(State.QT_BOTTOM))
			);
				
			if (oppositeMove) {
				// it was an opposite move. treat this like coming from a non-qt state
				this.setRealWindowTo(State.PADDED | (newSt & State.QT_ANY));
				return;
			}

			if (!was(State.PADDED)) {
				// we came from a non-quicktiled, non-padded state
				// .. snap to current quicktile
				this.setRealWindowTo(newSt & State.QT_ANY);
				return;
			}

			if (was(State.PADDED) && was(State.QUICKTILED)) {
				// we came from an existing padded quicktiled state of some kind

				// get repeated/doubled quicktile directions
				const repeats = change.same & State.QT_ANY;
				if (repeats !== 0) {
					// if any direction has repeated, then this is a signal to upgrade the quicktile

					// set this state to the full real quicktile state
					this.setRealWindowTo(oldSt & newSt & State.QT_ANY);
					return;
				}
			}

			// TODO: from non-qt/non-pad??
		}
	}
}

//
// init
//

new ClientManager(workspace).init();