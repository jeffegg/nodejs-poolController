import { EquipmentNotFoundError, InvalidEquipmentDataError, InvalidEquipmentIdError, ParameterOutOfRangeError } from '../../Errors';
import { utils, Timestamp } from '../../Constants';
import { logger } from '../../../logger/Logger';

import { NixieEquipment, NixieChildEquipment, NixieEquipmentCollection, INixieControlPanel } from "../NixieEquipment";
import { Valve, ValveCollection, sys } from "../../../controller/Equipment";
import { ValveState, state, } from "../../State";
import { setTimeout as setTimeoutSync, clearTimeout } from 'timers';
import { NixieControlPanel } from '../Nixie';
import { webApp, InterfaceServerResponse } from "../../../web/Server";
import {conn} from "../../comms/Comms";
import {Outbound, Protocol, Response} from "../../comms/messages/Messages";
import { setTimeout } from 'timers/promises';


export class NixieValveCollection extends NixieEquipmentCollection<NixieValve> {
    public async deleteValveAsync(id: number) {
        try {
            for (let i = this.length - 1; i >= 0; i--) {
                let valve = this[i];
                if (valve.id === id) {
                    await valve.closeAsync();
                    this.splice(i, 1);
                }
            }
        } catch (err) { return Promise.reject(`Nixie Control Panel deleteValveAsync ${err.message}`); }
    }
    public async setValveStateAsync(vstate: ValveState, isDiverted: boolean) {
        try {
            let valve: NixieValve = this.find(elem => elem.id === vstate.id) as NixieValve;
            if (typeof valve === 'undefined') {
                vstate.isDiverted = isDiverted;
                return logger.error(`Nixie Control Panel Error setValveState could not find valve ${vstate.id}-${vstate.name}`);
            }
            await valve.setValveStateAsync(vstate, isDiverted);
        } catch (err) { return Promise.reject(new Error(`Nixie Error setting valve state ${vstate.id}-${vstate.name}: ${err.message}`)); }
    }
    public async setValveAsync(valve: Valve, data: any) {
        // By the time we get here we know that we are in control and this is a Nixie valve.
        try {
            let c: NixieValve = this.find(elem => elem.id === valve.id) as NixieValve;

            if (typeof c === 'undefined') {
                valve.master = 1;
                c = new NixieValve(this.controlPanel, valve);
                data.id = valve.id;
                this.push(c);
                await c.setValveAsync(data);
                logger.info(`A valve was not found for id #${valve.id} creating valve`);
            }
            else {
                valve.master = 1;
                // I think the below line is causing all my problems
                //c.valve.master = 1;
                await c.setValveAsync(data);
            }
        }
        catch (err) { logger.error(`setValveAsync: ${err.message}`); return Promise.reject(err); }
    }
    public async searchValveAsync(): Promise<Valve[]>  {
        // By the time we get here we know that we are in control and this is a Nixie valve.
        try {
            if (conn.isPortEnabled( 0)) {
                let out = Outbound.create({
                    portId: 0,
                    protocol: Protocol.IntelliValve,
                    dest: 0xF,
                    action: 0x12,
                    payload: [1],
                    retries: 10, // IntelliCenter tries 4 times to get a response.
                    response: Response.create({ protocol: Protocol.IntelliValve, action: 0x52 }),
                    onAbort: () => { logger.error(`Communication aborted for find Valve`); },
                });
                try {
                    await out.sendAsync();

                    //return Promise.resolve(this.toString());
                }
                catch (err) {
                    logger.error(`Communication error when searching valves: ${err.message}`);
                    return Promise.reject(err);
                }
            }
        }
        catch (err) {
            logger.error(`setValveAsync: ${err.message}`);
            return Promise.reject(err);
        }
    }
    public async initAsync(valves: ValveCollection) {
        try {
            for (let i = 0; i < valves.length; i++) {
                let valve = valves.getItemByIndex(i);
                if (valve.master === 1) {
                    if (typeof this.find(elem => elem.id === valve.id) === 'undefined') {
                        let nvalve = new NixieValve(this.controlPanel, valve);
                        logger.info(`Initializing Nixie Valve ${nvalve.id}-${valve.name}`);
                        this.push(nvalve);
                        await nvalve.initAsync();
                    }
                }
            }
        }
        catch (err) { logger.error(`Nixie Valve initAsync Error: ${err.message}`); return Promise.reject(err); }
    }
    public async closeAsync() {
        try {
            for (let i = this.length - 1; i >= 0; i--) {
                try {
                    logger.info(`Closing Nixie Valve: ${this[i].id}`);
                    await this[i].closeAsync();
                    this.splice(i, 1);
                } catch (err) { logger.error(`Error stopping Nixie Valve ${err}`); }
            }

        } catch (err) { } // Don't bail if we have an errror.
    }

    public async initValveAsync(valve: Valve): Promise<NixieValve> {
        try {
            let c: NixieValve = this.find(elem => elem.id === valve.id) as NixieValve;
            if (typeof c === 'undefined') {
                c = new NixieValve(this.controlPanel, valve);
                this.push(c);
            }
            return c;
        } catch (err) { return Promise.reject(logger.error(`Nixie Controller: initValveAsync Error: ${err.message}`)); }
    }

}
export class NixieValve extends NixieEquipment {
    public pollingInterval: number = 10000;
    private _pollTimer: NodeJS.Timeout = null;
    protected _suspendPolling: number = 0;
    public closing = false;
    public valve: Valve;
    private _lastState;
    constructor(ncp: INixieControlPanel, valve: Valve) {
        super(ncp);
        this.valve = valve;
        this.pollEquipmentAsync();
    }
    public get id(): number { return typeof this.valve !== 'undefined' ? this.valve.id : -1; }
    public get suspendPolling(): boolean { return this._suspendPolling > 0; }
    public set suspendPolling(val: boolean) { this._suspendPolling = Math.max(0, this._suspendPolling + (val ? 1 : -1)); }
    public async setValveStateAsync(vstate: ValveState, isDiverted: boolean) {
        try {
            // Here we go we need to set the valve state.
            if (vstate.isDiverted !== isDiverted) {
                logger.verbose(`Nixie: Set valve ${vstate.id}-${vstate.name} to ${isDiverted}`);
            }
            if (utils.isNullOrEmpty(this.valve.connectionId) || utils.isNullOrEmpty(this.valve.deviceBinding)) {
                vstate.isDiverted = isDiverted;
                return new InterfaceServerResponse(200, 'Success');
            }
            if (typeof this._lastState === 'undefined' || isDiverted || this._lastState !== isDiverted) {
                let res = await NixieEquipment.putDeviceService(this.valve.connectionId, `/state/device/${this.valve.deviceBinding}`, { isOn: isDiverted, latch: isDiverted ? 10000 : undefined });
                if (res.status.code === 200) this._lastState = vstate.isDiverted = isDiverted;
                return res;
            }
            else {
                vstate.isDiverted = isDiverted;
                return new InterfaceServerResponse(200, 'Success');
            }
        } catch (err) { return logger.error(`Nixie Error setting valve state ${vstate.id}-${vstate.name}: ${err.message}`); }
    }
    public async setValveAsync(data: any) {
        try {
            let valve = this.valve;

            /*if (typeof type.maxCircuits !== 'undefined' && type.maxCircuits > 0 && typeof data.circuits !== 'undefined') { // This pump type supports circuits
                for (let i = 1; i <= data.circuits.length && i <= type.maxCircuits; i++) {
                    let c = data.circuits[i - 1];
                    c.id = i;
                    let circuit = parseInt(c.circuit, 10);
                    let cd = this.pump.circuits.find(elem => elem.circuit === circuit);
                    let speed = parseInt(c.speed, 10);
                    let relay = parseInt(c.relay, 10);
                    let flow = parseInt(c.flow, 10);
                    let units = typeof c.units !== 'undefined' ? sys.board.valueMaps.pumpUnits.encode(c.units) : undefined;

                    }*/
        }
        catch (err) { logger.error(`Nixie setValveAsync: ${err.message}`); return Promise.reject(err); }
    }

    public async initAsync() {
        try {
            // Start our polling but only after we clean up any other polling going on.
            if (this._pollTimer) {
                clearTimeout(this._pollTimer);
                this._pollTimer = undefined;
            }
            this.closing = false;
            this._suspendPolling = 0;
            // During startup it won't be uncommon for the comms to be out.  This will be because the body will be off so don't stress it so much.
            logger.debug(`Begin sending Valve messages ${this.valve.name}`);
            this.pollEquipmentAsync();
        } catch (err) { logger.error(`Error initializing ${this.valve.name} : ${err.message}`); }
    }

    public async pollEquipmentAsync() {
        let self = this;
        logger.silly(`Polling Valve: ${this.valve.name}, suspendPolling: ${this.suspendPolling}, state.mode: ${state.mode}, this.pollingInterval: ${this.pollingInterval}`)
        try {
            if (typeof this._pollTimer !== 'undefined' || this._pollTimer) {
                clearTimeout(this._pollTimer);
                this._pollTimer = undefined;
            }
            if (!this.suspendPolling) {
                try {
                    this.suspendPolling = true;
                    if (state.mode === 0) {
                        logger.silly(`Taking Control: ${this.valve.name}, suspendPolling: ${this.suspendPolling}, state.mode: ${state.mode}, this.pollingInterval: ${this.pollingInterval}`)
                        if (!this.closing) await this.takeControlAsync();
                        if (!this.closing) await setTimeout(300);
                        /*if (!this.closing) await this.setOutputAsync();
                        if (!this.closing) await setTimeout(300);
                        if (!this.closing) await this.getModelAsync();*/
                    }
                } catch (err) {
                    logger.error(`Valve ${this.valve.name} comms failure: ${err.message}`);
                }
                finally {
                    this.suspendPolling = false;
                    logger.silly(`Polling Valve1: ${this.valve.name}, suspendPolling: ${this.suspendPolling}, state.mode: ${state.mode}, this.pollingInterval: ${this.pollingInterval}`);
                }
            }

            let success = false;
        }
        catch (err) {
            logger.error(`Nixie Error polling valve - ${err}`);
        }
        finally {
            this.suspendPolling = false;
            logger.silly(`Polling Valve2: ${this.valve.name}, suspendPolling: ${this.suspendPolling}, state.mode: ${state.mode}, this.pollingInterval: ${this.pollingInterval}`);
            this._pollTimer = setTimeoutSync(async () => await self.pollEquipmentAsync(), this.pollingInterval || 10000);
        }
    }
    private async checkHardwareStatusAsync(connectionId: string, deviceBinding: string) {
        try {
            let dev = await NixieEquipment.getDeviceService(connectionId, `/status/device/${deviceBinding}`);
            return dev;
        } catch (err) { logger.error(`Nixie Valve checkHardwareStatusAsync: ${err.message}`); return { hasFault: true } }
    }

    public async takeControlAsync(): Promise<void> {
        //try {
        let vstate = state.valves.getItemById(this.valve.id, true);

        if (conn.isPortEnabled(this.valve.portId || 0) && (vstate.fwType === "Eggys IVFW")) {
            let out = Outbound.create({
                portId: this.valve.portId || 0,
                protocol: Protocol.IntelliValve,
                dest: this.valve.address,
                action: 0x28,
                payload: this.valve.UUID,
                retries: 10, // IntelliCenter tries 4 times to get a response.
                response: Response.create({ protocol: Protocol.IntelliValve, action: 0x2B }),
                onAbort: () => { logger.error(`Communication aborted with Valve ${this.valve.name}`); },
            });
            out.appendPayloadByte(this.valve.endstop0Value);
            out.appendPayloadByte(this.valve.endstop24Value);
            logger.silly(`Took Control of Valve Async1: ${vstate.name}`)
            try {
                await out.sendAsync();
                vstate.emitEquipmentChange();
            }
            catch (err) {
                logger.error(`Communication error with Valve ${this.valve.name} : ${err.message}`);

                //vstate.status = 128;
            }
        }
    }

    public async validateSetupAsync(valve: Valve, vstate: ValveState) {
        try {
            if (typeof valve.connectionId !== 'undefined' && valve.connectionId !== ''
                && typeof valve.deviceBinding !== 'undefined' && valve.deviceBinding !== '') {
                try {
                    let stat = await this.checkHardwareStatusAsync(valve.connectionId, valve.deviceBinding);
                    // If we have a status check the return.
                    vstate.commStatus = stat.hasFault ? 1 : 0;
                } catch (err) { vstate.commStatus = 1; }
            }
            else
                vstate.commStatus = 0;
            // The validation will be different if the valve is on or not.  So lets get that information.
        } catch (err) { logger.error(`Nixie Error checking Valve Hardware ${this.valve.name}: ${err.message}`); vstate.commStatus = 1; return Promise.reject(err); }
    }
    public async closeAsync() {
        try {
            this.closing = true; // This will tell the polling cycle to stop what it is doing and don't restart.
            if (typeof this._pollTimer !== 'undefined' || this._pollTimer) {
                clearTimeout(this._pollTimer);
                this._pollTimer = undefined;
            }
            let vstate = state.valves.getItemById(this.valve.id);
            logger.silly(`Closing Valve Async1: ${vstate.name}`)
            this.setValveStateAsync(vstate, false);
            vstate.emitEquipmentChange();
            await super.closeAsync();
        }
        catch (err) { logger.error(`Nixie Valve closeAsync: ${err.message}`); return Promise.reject(err); }
    }
    public logData(filename: string, data: any) { this.controlPanel.logData(filename, data); }
}
