import { ActionEvent } from "../action-event/action-event";
export declare class ActionInput {
    private input;
    private event;
    constructor(event: ActionEvent);
    get map(): Map<string, string>;
    toActArguments(): string[];
}
