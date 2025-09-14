import { EndpointDetails, RequestMocker } from "@kie/mock-github";
import { MockapiResponseMocker } from "../../mockapi/response/response-mocker";
export declare class MockapiRequestMocker extends RequestMocker {
    constructor(baseUrl: string, endpointDetails: EndpointDetails, allowUnmocked?: boolean);
    request(params?: Record<string, unknown>): MockapiResponseMocker;
}
