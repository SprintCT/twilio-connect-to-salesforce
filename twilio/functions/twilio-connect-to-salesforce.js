const axios = require('axios').default;
const querystring = require('querystring');
const moment = require('moment');

exports.handler = async function(context, event, callback) {
  try {
    const twilioClient = context.getTwilioClient();
    const sfAuthResponse = await getSalesforceAuth(twilioClient, context);
    const result = await insertPlatformEvent(context, event, sfAuthResponse);
    callback(null, result);
  } catch (e) {
    callback(e);
  }
}

async function getSalesforceAuth(twilioClient, context) {
  const ERROR_FORCE_REFRESH = 'ERROR_FORCE_REFRESH';
  try {
    // Check Against Sync Map
    let sfAuthResponse = await
    twilioClient.sync.
    services(context.TWILIO_SYNC_DEFAULT_SERVICE_SID).
    documents(context.SF_SYNC_KEY).fetch();

    const {
      data
    } = sfAuthResponse;
    const {
      dateCreated,
      dateExpires
    } = data;
    const currentDateTime = moment().format();

    if (moment().isAfter(dateExpires)) {
      throw ERROR_FORCE_REFRESH;
    }

    return data;
  } catch (e) {
    if (e.message === `The requested resource /Services/${context.TWILIO_SYNC_DEFAULT_SERVICE_SID}/Documents/${context.SF_SYNC_KEY} was not found` ||
      e === ERROR_FORCE_REFRESH) {
      // If not there then auth to Salesforce
      try {
        const sfAuthResponse = await authToSalesforce(context);

        sfAuthResponse.dateCreated = moment().format();
        sfAuthResponse.dateExpires = moment().add(context.SF_TTL, 'seconds').format();

        if (e === ERROR_FORCE_REFRESH) {
          // Update Sync Map
          await twilioClient.sync.
          services(context.TWILIO_SYNC_DEFAULT_SERVICE_SID).
          documents(context.SF_SYNC_KEY).update({
            data: sfAuthResponse,
            ttl: context.SF_TTL
          });
        } else {
          // Insert Sync Map
          await twilioClient.sync.
          services(context.TWILIO_SYNC_DEFAULT_SERVICE_SID).
          documents.create({
            uniqueName: context.SF_SYNC_KEY,
            data: sfAuthResponse,
            ttl: context.SF_TTL
          });
        }

        return sfAuthResponse;
      } catch (e) {
        throw formatErrorMsg(context, 'getSalesforceAuth - In Catch Block', e);
      }
    } else {
      throw formatErrorMsg(context, 'getSalesforceAuth', e);
    }
  }
}

async function authToSalesforce(context) {
  // Are we using a sandbox or not
  const isSandbox = (context.SF_IS_SANDBOX == 'true');

  //Consumer Key from Salesforce Connected app
  const clientId = context.SF_CONSUMER_KEY;

  //Consumer Secrect from Salesforce Connected app
  const clientSecret = context.SF_CONSUMER_SECRET;

  //The salesforce username;
  const sfUserName = context.SF_USERNAME;

  //The salesforce password
  const sfPassword = context.SF_PASSWORD;

  //The salesforce user token
  const sfToken = context.SF_TOKEN;

  const sfTokenTTL = context.SF_TTL;

  const useNameSpace = context.SF_USE_NAME_SPACE;

  //The salesforce managed package namespace
  const nameSpace = context.SF_NAME_SPACE;

  //The login url
  let salesforceUrl = 'https://login.salesforce.com';

  if (isSandbox === true) {
    salesforceUrl = 'https://test.salesforce.com';
  }
  try {
    const form = {
      grant_type: 'password',
      client_id: clientId,
      client_secret: clientSecret,
      username: sfUserName,
      password: sfPassword + sfToken
    };

    const formData = querystring.stringify(form);
    const contentLength = formData.length;
    const sfAuthReponse = await axios({
      method: 'POST',
      headers: {
        'Content-Length': contentLength,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      url: `${salesforceUrl}/services/oauth2/token`,
      data: querystring.stringify(form)
    });


    return sfAuthReponse.data;
  } catch (e) {
    throw formatErrorMsg(context, 'authToSalesforce', e);
  }
}

async function insertPlatformEvent(context, event, sfAuthResponse) {
  try {
    const platformEvent = buildPlatformEvent(context, event);
    const url = sfAuthResponse.instance_url + getPlatformEventUrl(context);

    const result = await axios({
      url,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sfAuthResponse.access_token}`
      },
      data: platformEvent,
    });

    return result.data;
  } catch (e) {
    throw formatErrorMsg(context, 'insertPlatformEvent', e);
  }
}

function getPlatformEventUrl(context) {
  if (context.SF_USE_NAME_SPACE) {
    return `/services/data/v43.0/sobjects/${context.SF_NAME_SPACE}Twilio_Message_Status__e`;
  } else {
    return '/services/data/v43.0/sobjects/Twilio_Message_Status__e';
  }
}

function buildPlatformEvent(context, event) {
  const eventToPEMap = {
    "Body": "Body__c",
    "To": "To__c",
    "From": "From__c",
    "AccountSid": "AccountSid__c",
    "SmsSid": "MessageSid__c",
    "MessagingServiceSid": "MessagingServiceSid__c",
    "SmsStatus": "SmsStatus__c",
    "ErrorCode": "ErrorCode__c"
  };

  const platformEvent = {};

  for (const property in event) {
    if (eventToPEMap.hasOwnProperty(property)) {
      let eventProp;
      if (context.SF_USE_NAME_SPACE) {
        eventProp = context.SF_NAME_SPACE + eventToPEMap[property];
      } else {
        eventProp = eventToPEMap[property];
      }
      platformEvent[eventProp] = event[property];
    }
  }

  return platformEvent;
}

function formatErrorMsg(context, functionName, errorMsg) {
  return `Twilio Function Path: ${context.PATH} \n Function Name: ${functionName} \n Error Message: ${errorMsg}`
}