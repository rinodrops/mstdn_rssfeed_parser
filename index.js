// mstdn_rssfeed_parser
// Parse RSS Feed of Mastodon to retrieve information of the newly created post
// for AWS Lambda + DynamoDB

// import dependencies
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import axios from 'axios';
import xml2js from 'xml2js';
import TwitterTextParser from 'twitter-text';
import { htmlToText } from 'html-to-text';

// read .env file and set constants
import dotenv from 'dotenv';
dotenv.config();
const IFTTT_EVENT_NAME = process.env.IFTTT_EVENT_NAME;
const IFTTT_EVENT_NAME_WITH_IMAGE = process.env.IFTTT_EVENT_NAME_WITH_IMAGE;
const IFTTT_KEY = process.env.IFTTT_KEY;
const TABLE_NAME = process.env.TABLE_NAME;
const RSS_FEED_URL = process.env.RSS_FEED_URL;
const DYNAMODB_REGION = process.env.DYNAMODB_REGION;
const MAX_ITEMS = parseInt(process.env.MAX_ITEMS, 10);
const LOG_LEVEL = process.env.LOG_LEVEL;

// instantiate the DynamoDB client
const ddb = new DynamoDBClient({ region: DYNAMODB_REGION });

export const handler = async (event) => {
    // read RSS Feed
    const rssFeedResponse = await axios.get(RSS_FEED_URL);
    if (LOG_LEVEL === 'debug') console.log('RSS feed response:', rssFeedResponse.data);

    // get the last processed item's publish time
    const lastProcessedItem = await ddb.send(new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { id: { S: 'last_processed_item' } },
    }));
    let lastProcessedPubDate = lastProcessedItem.Item ? parseInt(lastProcessedItem.Item.pubDate.N) : null;
    let newProcessedPubDate = lastProcessedPubDate;
    if (LOG_LEVEL === 'debug') console.log('Last processed item:', lastProcessedItem.Item);

    // instantiate the XML parser
    const parser = new xml2js.Parser();
    try {
        // <rss>
        //   <channel>
        //     <item>                // each post
        //       <guid>
        //       <link>              // parmalink
        //       <pubDate>           // published time
        //       <description>       // content of the post
        //       <media:content url> // media url
        const result = await parser.parseStringPromise(rssFeedResponse.data);

        // get items as array
        const items = result.rss.channel[0].item;
        if (LOG_LEVEL === 'debug') console.log('Parsed items:', items);

        // limit to MAX_ITEMS
        // this code assumes that the items in the RSS Feed array are
        // ordered from newest to oldest.
        const latestItems = items.slice(0, MAX_ITEMS).reverse();
        if (LOG_LEVEL === 'debug') console.log('Latest items:', latestItems);

        // calling IFTTT webhook could take time, so it is necessary
        // to wait until all the requests are processed
        // to track for each item, create promises to store them
        const postPromises = latestItems.map(async item => {
            // get pubDate and convert it to the number in milliseconds
            // since the Unix epoch (January 1, 1970)
            const pubDate = new Date(item.pubDate[0]).getTime();
            if (LOG_LEVEL === 'debug') console.log('pubDate:', pubDate);

            if (item.category && item.category.find(cat => cat.toLowerCase() === 'nocrosspost')) {
                return Promise.resolve(); // skip this item
            }

            // process only items newer than the last processed one
            if (!lastProcessedPubDate || lastProcessedPubDate < pubDate) {
                // extract permalink, pubDate and the content
                // they should exist in every post
                const permalink = item.link[0];
                const published = item.pubDate[0];
                const content = htmlToText(item.description[0]);

                // parse the content into segments
                let contentSegments = [];
                let remainingContent = content;
                let segment = '';
                let separator = '====';

                while (remainingContent.length > 0) {
                    let separatorIndex = remainingContent.indexOf(separator);
                    if (separatorIndex >= 0 && separatorIndex < 280) {
                        segment = remainingContent.substring(0, separatorIndex);
                        remainingContent = remainingContent.substring(separatorIndex + separator.length);
                    } else {
                        let potentialSegment = remainingContent.substring(0, 280);
                        let segmentLength = TwitterTextParser.parseTweet(potentialSegment).weightedLength;

                        while (segmentLength > 280) {
                            potentialSegment = potentialSegment.substring(0, potentialSegment.length - 1);
                            segmentLength = TwitterTextParser.parseTweet(potentialSegment).weightedLength;
                        }

                        segment = potentialSegment;
                        separatorIndex = remainingContent.indexOf(separator);

                        if (separatorIndex === segment.length) {
                            remainingContent = remainingContent.substring(separatorIndex + separator.length);
                        } else {
                            remainingContent = remainingContent.substring(segment.length);
                        }
                    }
                    contentSegments.push(segment);
                }

                let firstSegment = true;
                for (const segment of contentSegments) {
                    let iftttEventName = IFTTT_EVENT_NAME;

                    const postData = { value1: segment };

                    // if media is attached...
                    if (firstSegment && item['media:content']) {
                        // get the url of the first media file
                        postData.value2 = item['media:content'][0].$.url;
                        iftttEventName = IFTTT_EVENT_NAME_WITH_IMAGE;
                    }
                    if (LOG_LEVEL === 'debug') console.log('postData:', postData);

                    // update the last processed item's date
                    if (!newProcessedPubDate || newProcessedPubDate < pubDate) newProcessedPubDate = pubDate;
                    if (LOG_LEVEL === 'debug') console.log('Renewed pubDate:', newProcessedPubDate);

                    // make an IFTTT webhook request in sync
                    const webhookUrl = `https://maker.ifttt.com/trigger/${iftttEventName}/with/key/${IFTTT_KEY}`;
                    await axios.post(webhookUrl, postData,
                        {headers: {'Content-Type': 'application/json'}}
                    );

                    firstSegment = false;
                }
                return Promise.resolve;
            }
            else {
                return Promise.resolve();
            }
        });

        if (LOG_LEVEL === 'debug') console.log('Post promises:', postPromises);

        // store the last processed item's date
        return Promise.allSettled(postPromises)
            .then(() => {
                if (LOG_LEVEL === 'debug') console.log('Post promises:', postPromises);
                if (LOG_LEVEL === 'debug') console.log('All promises have resolved');
                return ddb.send(new PutItemCommand({
                        TableName: TABLE_NAME,
                        Item: {
                            id: { S: 'last_processed_item' },
                            pubDate: { N: newProcessedPubDate.toString() },
                        },
                    }));
            })
            .catch(error => {
                if (LOG_LEVEL === 'debug') console.log('Post promises:', postPromises);
                if (LOG_LEVEL === 'debug') console.log('Error in Promise.all():', error);
            });
    }
    catch (error) {
        console.log("An error occurred:", error);
    }
};
