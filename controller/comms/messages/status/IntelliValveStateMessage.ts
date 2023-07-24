/*  nodejs-poolController.  An application to control pool equipment.
Copyright (C) 2016, 2017, 2018, 2019, 2020, 2021, 2022.  
Russell Goldin, tagyoureit.  russ.goldin@gmail.com

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
import {Inbound, Outbound, Protocol} from "../Messages";
import { state } from "../../../State";
import { sys, ControllerType } from "../../../Equipment";
import { logger } from "../../../../logger/Logger";
import {conn} from "../../Comms";

export class IntelliValveStateMessage {
    public static process(msg: Inbound) {
        if (sys.controllerType === ControllerType.Unknown) return;
        // We only want to process the messages that are coming from IntelliValve.
        //if (msg.source !== 12) return;
        switch (msg.action) {
            case 43:
                let endstop0Value = msg.extractPayloadByte(6);
                let endstop24Value = msg.extractPayloadByte(7);
                let selectedEndstop = msg.extractPayloadByte(8) == 1 ? "Endstop 24" : "Endstop 0";
                let currentPosition = msg.extractPayloadByte(9) * 3.75;
                let currentModeNum = msg.extractPayloadByte(10);
                let currentMode = 'Unknown'
                if (currentModeNum === 0x4)
                    currentMode = 'Auto'
                else if (currentModeNum === 0x5)
                    currentMode = 'Settings'
                else if (currentModeNum === 0x6)
                    currentMode = 'Maintenance'

                let uuid_array_1 = [msg.payload[2], msg.payload[3], msg.payload[4], msg.payload[5], msg.payload[6], msg.payload[7]];

                logger.info(`VALVE_ENDSTOPS(${msg.action}) from valve ${msg.source}, with data: ${msg.payload}`);
                logger.info(`Valve UUID:        ${uuid_array_1.toString()}`);
                logger.info(`Endstop 0 Value:   ${endstop0Value.toString()}`);
                logger.info(`Endstop 24 Value:  ${endstop24Value.toString()}`);
                logger.info(`Selected Endstop:  ${selectedEndstop}`);
                logger.info(`Current Position:  ${currentPosition.toString()}`);
                logger.info(`Current Mode:      ${currentMode}`);


                let valve1 = sys.valves.find(x => JSON.stringify(x.UUID) === JSON.stringify(uuid_array_1));

                if (typeof valve1 === 'undefined') {
                    logger.info(`UUID not found: ${uuid_array_1.toString()}`);
                } else {
                    let svalve1 = state.valves.getItemById(valve1.id, true);
                    logger.info(`UUID found: ${uuid_array_1.toString()}`);
                    valve1.endstop0Value = endstop0Value;
                    valve1.endstop24Value = endstop24Value;
                    valve1.selectedEndstop = selectedEndstop;
                    valve1.currentPosition = currentPosition;
                    valve1.currentMode = currentMode;

                    svalve1.endstop0Value = valve1.endstop0Value;
                    svalve1.endstop24Value = valve1.endstop24Value;
                    svalve1.selectedEndstop = valve1.selectedEndstop;
                    svalve1.currentPosition = valve1.currentPosition;
                    svalve1.currentMode = valve1.currentMode;
                }
                break;
            case 82: // This is hail from the valve that says it is not bound yet.
                let uuid_array = [1];
                let gitHash = 0xFFFF
                let fwDate = 0xFFFF
                let did = 0xFFFF
                let rid = 0xFFFF
                let fwType = "Unknown";
                let fw_branch_size = 0;
                let fw_tag_size = 0;
                let fw_branch = "?";
                let fw_tag = "?";
                let reset_reason = 0xFF;
                let pcon = 0xFF;
                let status = 0xFF;


                if ((msg.source == 12) && (msg.payload.length == 8))// Pentair FW found, don't add valve+
                {
                    if ((msg.payload[0] == 0x0) && (msg.payload[1] == 0x80)) {
                        uuid_array = [msg.payload[0], msg.payload[1], msg.payload[2], msg.payload[3], msg.payload[4], msg.payload[5]];
                        logger.info(`Hail Seen(${msg.action}) from valve with Pentair FW: ${msg.source}, with data: ${msg.payload}`);
                        logger.info(`Valve UUID: ${uuid_array.toString()}`);
                        gitHash = 0xFFFF
                        fwDate = 0xFFFF
                        did = 0xFFFF
                        rid = 0xFFFF
                        fwType = "Pentair FW";
                        fw_branch_size = 0xf
                        fw_tag_size = 0xF;
                        fw_branch = "";
                        fw_tag = "";
                        reset_reason = 0xFF;
                        return;
                    }
                    else
                    {
                        logger.warn(`Hail Seen(${msg.action}) from valve ${msg.source}, with data: ${msg.payload}. But we don't know what valve this is.`);
                        return;
                    }
                }
                else
                {
                    gitHash = msg.extractPayloadDWord(6);
                    fwDate = msg.extractPayloadDWord(10);
                    did = msg.extractPayloadInt(14);
                    rid = msg.extractPayloadInt(16);
                    fw_branch_size = msg.extractPayloadByte(18);
                    fw_tag_size = msg.extractPayloadByte(19);
                    fw_branch = msg.extractPayloadString(20, fw_branch_size);
                    fw_tag = msg.extractPayloadString(20 + fw_branch_size, fw_tag_size);
                    reset_reason = msg.extractPayloadByte(20 + fw_branch_size + fw_tag_size + 1);
                    pcon = msg.extractPayloadByte(20 + fw_branch_size + fw_tag_size + 2);
                    status = msg.extractPayloadByte(20 + fw_branch_size + fw_tag_size + 3);

                    uuid_array = [msg.payload[0], msg.payload[1], msg.payload[2], msg.payload[3], msg.payload[4], msg.payload[5]];
                    fwType = "Eggys IVFW"

                    logger.info(`Hail Seen(${msg.action}) from valve with EggysIVFW ${msg.source}, with data: ${msg.payload}`);
                    logger.info(`Valve UUID:  ${uuid_array.toString()}`);
                    logger.info(`Tag:         ${fw_tag}`);
                    logger.info(`Branch:      ${fw_branch}`);
                    logger.info(`GIT Hash:    ${gitHash.toString(16)}`);
                    logger.info(`FW Date:     ${fwDate.toString(16)}`);
                    logger.info(`Valve DID:   ${did.toString(16)}`);
                    logger.info(`Valve RID:   ${rid.toString(16)}`);
                    logger.info(`Last Reset:  ${reset_reason.toString(16)}`)
                    logger.info(`Last PCON:   ${pcon.toString(16)}`)
                    logger.info(`Last Status: ${status.toString(16)}`)
                }

                let valve = sys.valves.find(x => JSON.stringify(x.UUID) === JSON.stringify(uuid_array));
                if (typeof valve === 'undefined') {
                    logger.info(`Adding new valve with UUID: ${uuid_array.toString()}`);
                    let id = sys.valves.filter(elem => elem.master === 0).getMaxId(false, 0) + 1;
                    valve = sys.valves.getItemById(id, true);
                    valve.id = id;
                    valve.name = fwType == "Eggys IVFW" ? `iValve ${msg.source - 160}`: `Valve ${id}`;
                    valve.UUID = uuid_array;
                    valve.type = 1;
                    valve.isActive = true;
                    valve.master = 0;
                }
                else
                {
                    logger.info(`Found valve with UUID: ${uuid_array.toString()} and ID ${valve.id}`);
                }
                valve.address = msg.source;
                valve.fwVersion = gitHash;
                valve.fwDate = fwDate;
                valve.fwType = fwType;

                valve.fwTag = fw_tag;
                valve.fwBranch = fw_branch;

                valve.did = did;
                valve.rid = rid;

                switch(reset_reason)
                {
                    case 0x0:
                        valve.resetReason = "Unknown";
                        break;
                    case 0x1:
                        valve.resetReason = "Stack Overflow";
                        break;
                    case 0x2:
                        valve.resetReason = "Stack Underflow";
                        break;
                    case 0x3:
                        valve.resetReason = "Power-on Reset";
                        break;
                    case 0x4:
                        valve.resetReason = "Illegal, TO is set on POR";
                        break;
                    case 0x5:
                        valve.resetReason = "Illegal, PD is set on POR";
                        break;
                    case 0x6:
                        valve.resetReason = "Brown-out Reset";
                        break;
                    case 0x7:
                        valve.resetReason = "WDT Reset";
                        break;
                    case 0x8:
                        valve.resetReason = "WDT Wake-up from Sleep";
                        break;
                    case 0x9:
                        valve.resetReason = "MCLR Reset during Sleep";
                        break;
                    case 0xa:
                        valve.resetReason = "Interrupt Wake-up from Sleep";
                        break;
                    case 0xb:
                        valve.resetReason = "MCLR Reset during normal operation";
                        break;
                    case 0xc:
                        valve.resetReason = "RESET Instruction Executed";
                        break;
                    default:
                        valve.resetReason = `Invalid: ${reset_reason.toString(16)}`
                        break;
                }
                let svalve = state.valves.getItemById(valve.id, true);
                svalve.address = valve.address;
                svalve.type = valve.type;
                svalve.isActive = valve.isActive;
                svalve.name = valve.name;
                svalve.type = valve.type;
                svalve.UUID = valve.UUID;
                svalve.fwVersion = valve.fwVersion;
                svalve.fwDate = valve.fwDate;
                svalve.did = valve.did;
                svalve.rid = valve.rid;
                svalve.fwType = valve.fwType;
                svalve.fwTag = valve.fwTag;
                svalve.fwBranch = valve.fwBranch ;

                let out = Outbound.create({
                                portId: 0,
                                protocol: Protocol.IntelliValve,
                                dest: msg.source,
                                action: 0x2A,
                                payload: uuid_array,
                                retries: 10,
                                response: false,
                                onComplete: (err, _) => {
                                    if (err) {
                                        logger.error(`Intellivalve VALVE_GET_ENDSTOPS failed for ${valve.name}: ${err.message}`);
                                    }
                                }
                            });
                        conn.queueSendMessage(out);
                break;
            default:
                logger.info(`IntelliValve sent an unknown action ${msg.action}`);
                break;
        }
        state.emitEquipmentChanges();
    }
}