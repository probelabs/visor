import { EventJSON } from "../action-event/action-event.types";
export declare class ActionEvent {
    private _event;
    private tmpPath?;
    constructor();
    get event(): EventJSON;
    set event(event: EventJSON);
    toActArguments(): Promise<string[]>;
    removeEvent(): Promise<void>;
}
