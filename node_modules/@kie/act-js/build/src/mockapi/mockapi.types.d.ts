import { Endpoints } from "@kie/mock-github";
import { MockapiRequestMocker } from "../mockapi/request/request-mocker";
export declare type API = {
    [apiName: string]: {
        baseUrl: string;
        endpoints: Endpoints;
    };
};
export declare type MockapiMethod = {
    [apiName: string]: {
        [scope: string]: {
            [methodName: string]: typeof MockapiRequestMocker.prototype.request;
        };
    };
};
